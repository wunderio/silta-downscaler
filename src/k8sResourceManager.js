const k8s = require('@kubernetes/client-node');
const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sExtensionsApi = kc.makeApiClient(k8s.ExtensionsV1beta1Api);
const k8sBatchApi = kc.makeApiClient(k8s.BatchV1beta1Api);
const k8sAppApi = kc.makeApiClient(k8s.AppsV1Api);

const placeholderServiceName = process.env.PLACEHOLDER_SERVICE_NAME;
const placeholderServiceNamespace = process.env.PLACEHOLDER_SERVICE_NAMESPACE;

const moment = require('moment');

class K8sResourceManager {
  async loadResources(namespace, labelSelector) {
    try {
      const deployments = (await k8sExtensionsApi.listNamespacedDeployment(namespace, null, null, null, null, labelSelector)).body.items;
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

          console.log(resourceStatus);
          if (resourceStatus.every(resource => resource.isReady)) {
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

        console.log(`Redirected service ${serviceName} to placeholder service`);
      }
    }
    catch (error) {
      console.error(`Error updating ${serviceName}`, error);
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

    console.log(`Redirected service ${serviceName} to placeholder service`);
  }

  async getResourceStatus(resource, kind) {
    const name = resource.metadata.name;

    // TODO: use class name instead of explicit "kind" parameter
    console.log(resource.constructor.name);

    const desiredReplicas = resource.spec.replicas;
    const currentReplicas = resource.status.readyReplicas || 0;

    return {
      name: name,
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
          let api, method;
          if (kind === 'deployment') {
            api = k8sExtensionsApi;
            method = 'patchNamespacedDeployment';
          }
          else {
            api = k8sAppApi;
            method = 'patchNamespacedStatefulSet';
          }

          // Downscale the deployment or statefulset.
          await api[method](name, namespace, {
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

          console.log(`Downscaled ${kind} ${name} from ${replicas} to 0`);
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
          console.log(`Suspended cronjob ${name}`);
        }
      }
    }
    catch (error) {
      console.error(`Error while downscaling ${kind} ${name}`, error.message);
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
          let api, method;
          if (kind === 'deployment') {
            api = k8sExtensionsApi;
            method = 'patchNamespacedDeployment';
          }
          else {
            api = k8sAppApi;
            method = 'patchNamespacedStatefulSet';
          }

          // Downscale the deployment or statefulset.
          await api[method](name, namespace, {
            metadata: {
              annotations: {
                'auto-downscale/original-replicas': null,
                'auto-donwscale/last-update': moment().toISOString()
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

          console.log(`Upscaled ${kind} ${name} from 0 to ${originalReplicas}`);
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
          console.log(`Unsuspended cronjob ${name}`);
        }
      }
    }
    catch (error) {
      console.error(`Error while downscaling ${kind} ${name}`, error.message);
    }
  };
};

module.exports = new K8sResourceManager();