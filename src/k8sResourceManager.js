const k8s = require('@kubernetes/client-node');
const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sNetworkApi = kc.makeApiClient(k8s.NetworkingV1beta1Api);
const k8sBatchApi = kc.makeApiClient(k8s.BatchV1beta1Api);
const k8sAppApi = kc.makeApiClient(k8s.AppsV1Api);

const placeholderServiceName = process.env.PLACEHOLDER_SERVICE_NAME;
const placeholderServiceNamespace = process.env.PLACEHOLDER_SERVICE_NAMESPACE;

const moment = require('moment');
const crypto = require('crypto')

class K8sResourceManager {
  async loadResources(namespace, labelSelector) {
    try {
      const deployments = (await k8sAppApi.listNamespacedDeployment(namespace, null, null, null, null, labelSelector)).body.items;
      const cronjobs = (await k8sBatchApi.listNamespacedCronJob(namespace, null, null, null, null, labelSelector)).body.items;
      const statefulsets = (await k8sAppApi.listNamespacedStatefulSet(namespace, null, null, null, null, labelSelector)).body.items;

      return {
        deployments,
        cronjobs,
        statefulsets,
      }
    } catch (error) {
      console.error(`Error loading resources matching ${labelSelector} in ${namespace}`, error);
    }
  };

  async loadResourcesStatus(namespace, labelSelector) {
    const {deployments, cronjobs, statefulsets} = await this.loadResources(namespace, labelSelector);

    return Promise.all([
      ... deployments.map(async deployment => this.getResourceStatus(deployment, 'deployment')),
      ... statefulsets.map(async statefulset => this.getResourceStatus(statefulset, 'statefulset')),
    ]);
  };

  async waitForResourcesReady(namespace, labelSelector) {
    return new Promise(async (resolve, reject) => {

      try {
        const intervalHandle = setInterval(async () => {
          const resourceStatus = await this.loadResourcesStatus(namespace, labelSelector);

          if (resourceStatus.every(resource => resource.isReady)) {
            console.log("%s/%s selector resources are ready", namespace, labelSelector)
            clearInterval(intervalHandle);
            resolve();
          }
        }, 10000);
      }
      catch (e) {
        reject(e);
      }
    });
  }

  async redirectService(serviceName, namespace) {
    try {
      const service = (await k8sApi.readNamespacedService(serviceName, namespace)).body;

      if (!service.metadata.annotations || service.metadata.annotations['auto-downscale/down'] != 'true') {

        await k8sApi.patchNamespacedService(serviceName, namespace, {
          metadata: {
            annotations: {
              'auto-downscale/down': 'true',
              'auto-downscale/original-type': service.spec.type,
              'auto-downscale/original-selector': JSON.stringify(service.spec.selector)
            }
          },
          spec: {
            type: 'ExternalName',
            externalName: `${placeholderServiceName}.${placeholderServiceNamespace}`,
            clusterIP: null,
            selector: null,
          }
        }, undefined, undefined, undefined, undefined, {
          headers: {
            'Content-Type': 'application/merge-patch+json'
          }
        });

        console.log(`Redirected service ${namespace}/${serviceName} to placeholder service`);
      }
    }
    catch (error) {
      console.error(`Error updating ${namespace}/${serviceName}`, error);
    }
  };

  async resetService(serviceName, namespace) {
    const service = (await k8sApi.readNamespacedService(serviceName, namespace)).body;

    await k8sApi.patchNamespacedService(serviceName, namespace, {
      metadata: {
        annotations: {
          'auto-downscale/down': null,
          'auto-downscale/original-type': null,
          'auto-downscale/original-selector': null
        }
      },
      spec: {
        type: service.metadata.annotations['auto-downscale/original-type'],
        externalName: null,
        selector: JSON.parse(service.metadata.annotations['auto-downscale/original-selector']),
      }
    }, undefined, undefined, undefined, undefined, {
      headers: {
        'Content-Type': 'application/merge-patch+json'
      }
    });

    console.log(`Reset service ${namespace}/${serviceName} to original service`);
  }

  async updateIngressLastUpdate(ingressName, namespace) {
    await k8sNetworkApi.patchNamespacedIngress(ingressName, namespace, {
      metadata: {
        annotations: {
          'auto-downscale/last-update': moment().toISOString(),
          'auto-downscale/down': null,
        }
      },
    }, undefined, undefined, undefined, undefined, {
      headers: {
        'Content-Type': 'application/merge-patch+json'
      }
    });

    console.log(`Updated last-update annotation on ${namespace}/${ingressName} ingress`);
  }

  async markIngressAsDown(ingressName, namespace) {
    await k8sNetworkApi.patchNamespacedIngress(ingressName, namespace, {
      metadata: {
        annotations: {
          'auto-downscale/down': 'true',
        }
      },
    }, undefined, undefined, undefined, undefined, {
      headers: {
        'Content-Type': 'application/merge-patch+json'
      }
    });

    console.log(`Marked ingress ${namespace}/${ingressName} as down`);
  }

  async getResourceStatus(resource, kind) {
    const name = resource.metadata.name;

    // TODO: use class name instead of explicit "kind" parameter
    // console.log(resource.constructor.name);

    const desiredReplicas = resource.spec.replicas;
    const currentReplicas = resource.status.readyReplicas || 0;
    const name_hash = crypto.createHash('md5').update(name).digest("hex")

    return {
      name: name_hash,
      type: kind,
      message: `${currentReplicas} / ${desiredReplicas}`,
      desiredCount: desiredReplicas,
      readyCount: currentReplicas,
      isReady: currentReplicas === desiredReplicas,
    };
  }


  async downscaleResource(resource, kind) {
    const name = resource.metadata.name;
    const namespace = resource.metadata.namespace;
    try {

      if (kind === 'deployment' || kind === 'statefulset') {
        const replicas = resource.spec.replicas;

        if (replicas > 0) {
          let method;
          if (kind === 'deployment') {
            method = 'patchNamespacedDeployment';
          }
          else {
            method = 'patchNamespacedStatefulSet';
          }

          // Downscale the deployment or statefulset.
          await k8sAppApi[method](name, namespace, {
            metadata: {
              annotations: {
                'auto-downscale/original-replicas': `${replicas}`
              }
            },
            spec: {
              replicas: 0
            }
          }, undefined, undefined, undefined, undefined, {
            headers: {
              'Content-Type': 'application/merge-patch+json'
            }
          });

          console.log(`Downscaled ${kind} ${namespace}/${name} from ${replicas} to 0`);
        }
      }
      else if (kind === 'cronjob') {
        const suspended = resource.spec.suspend;
        if (!suspended) {
          await k8sBatchApi.patchNamespacedCronJob(name, namespace, {
            spec: {
              suspend: true
            }
          }, undefined, undefined, undefined, undefined, {
            headers: {
              'Content-Type': 'application/merge-patch+json'
            }
          });
          console.log(`Suspended cronjob ${namespace}/${name}`);
        }
      }
    }
    catch (error) {
      console.error(`Error while downscaling ${kind} ${namespace}/${name}`, error.message);
    }
  };

  async upscaleResource(resource, kind) {
    const name = resource.metadata.name;
    const namespace = resource.metadata.namespace;

    try {

      if (kind === 'deployment' || kind === 'statefulset') {
        const replicas = resource.spec.replicas;
        const originalReplicas = parseInt(resource.metadata.annotations['auto-downscale/original-replicas']) || 1;
        console.log(`Requesting to scale ${resource.metadata.name} to ${originalReplicas} replica(s)`);

        if (originalReplicas != replicas) {
          let method;
          if (kind === 'deployment') {
            method = 'patchNamespacedDeployment';
          }
          else {
            method = 'patchNamespacedStatefulSet';
          }

          // Upscale the deployment or statefulset.
          await k8sAppApi[method](name, namespace, {
            metadata: {
              annotations: {
                'auto-downscale/original-replicas': null
              }
            },
            spec: {
              replicas: originalReplicas
            }
          }, undefined, undefined, undefined, undefined, {
            headers: {
              'Content-Type': 'application/merge-patch+json'
            }
          });

          console.log(`Upscaled ${kind} ${namespace}/${name} from 0 to ${originalReplicas}`);
        }
      }
      else if (kind === 'cronjob') {
        const suspended = resource.spec.suspend;
        if (suspended) {
          await k8sBatchApi.patchNamespacedCronJob(name, namespace, {
            spec: {
              suspend: false
            }
          }, undefined, undefined, undefined, undefined, {
            headers: {
              'Content-Type': 'application/merge-patch+json'
            }
          });
          console.log(`Unsuspended cronjob ${namespace}/${name}`);
        }
      }
    }
    catch (error) {
      console.error(`Error while downscaling ${kind} ${namespace}/${name}`, error.message);
    }
  };

  async extractScalableResourcesFromIngress(ingress) {
    try {
      const labels = ingress.metadata.labels;
      const labelSelector1 = 'release='+labels['release'];
      const labelSelector2 = 'app.kubernetes.io/instance='+labels['app.kubernetes.io/instance'];
      const namespace = ingress.metadata.namespace;

      var {deployments, cronjobs, statefulsets} = await this.loadResources(namespace, labelSelector1);
      const deployments1 = deployments;
      const cj1 = cronjobs;
      const sts1 = statefulsets;

      var {deployments, cronjobs, statefulsets} = await this.loadResources(namespace, labelSelector2);
      const deployments2 = deployments;
      const cj2 = cronjobs;
      const sts2 = statefulsets;

      var all_deployments = deployments1.concat(deployments2);
      all_deployments = all_deployments.filter((deployment, index, self) =>
        index === self.findIndex((t) => (
          t.metadata.uid === deployment.metadata.uid
        ))
      )

      var all_cjs = cj1.concat(cj2);
      all_cjs = all_cjs.filter((cronjob, index, self) =>
        index === self.findIndex((t) => (
          t.metadata.uid === cronjob.metadata.uid
        ))
      )

      var all_stss = sts1.concat(sts2);
      all_stss = all_stss.filter((statefulset, index, self) =>
        index === self.findIndex((t) => (
          t.metadata.uid === statefulset.metadata.uid
        ))
      )

      var deployments = all_deployments;
      var cronjobs = all_cjs;
      var statefulsets = all_stss;

      return {
        deployments,
        cronjobs,
        statefulsets
      }
    } catch (error) {
      console.error(`Error loading resources from ingress ${ingress.metadata.name}`, error);
    }
  }
  
};

module.exports = new K8sResourceManager();
