const k8s = require('@kubernetes/client-node');
const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sNetworkApi = kc.makeApiClient(k8s.NetworkingV1Api);
const k8sBatchApi = kc.makeApiClient(k8s.BatchV1Api);
const k8sAppApi = kc.makeApiClient(k8s.AppsV1Api);

const placeholderServiceName = process.env.PLACEHOLDER_SERVICE_NAME;
const placeholderServiceNamespace = process.env.PLACEHOLDER_SERVICE_NAMESPACE;
const placeholderProxyImage = process.env.PLACEHOLDER_PROXY_IMAGE;

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

        // Check if nginx deployment exists
        await k8sAppApi.readNamespacedDeployment('silta-cluster-placeholder-upscaler-proxy', namespace).catch(
          (error) => {
            console.log("Spinning up upscaler proxy deployment in %s namespace", namespace)
            // Spin up upscaler proxy to handle traffic
            k8sAppApi.createNamespacedDeployment(namespace, {
              metadata: {
                name: `silta-cluster-placeholder-upscaler-proxy`,
              },
              spec: {
                replicas: 1,
                selector: {
                  matchLabels: {
                    app: 'silta-cluster-placeholder-upscaler-proxy'
                  }
                },
                template: {
                  metadata: {
                    labels: {
                      app: 'silta-cluster-placeholder-upscaler-proxy'
                    }
                  },
                  spec: {
                    enableServiceLinks: false,
                    containers: [
                      {
                        name: 'nginx',
                        image: `${placeholderProxyImage}`,
                        env: [
                          {
                            name: 'PLACEHOLDER_SERVICE_NAME',
                            value: `${placeholderServiceName}`
                          },
                          {
                            name: 'PLACEHOLDER_SERVICE_NAMESPACE',
                            value: `${placeholderServiceNamespace}`
                          },
                        ],
                        ports: [
                          {
                            containerPort: 8080,
                          }
                        ],
                        resources: {
                          // requests: {
                          //   cpu: '1m',
                          //   memory: '10Mi',
                          // },
                          limits: {
                            cpu: '1m',
                            memory: '10Mi',
                          },
                        }
                      }
                    ]
                  }
                }
              }
            });

            // Wait for deployment to be ready so requests don't get dropped with 50x
            return new Promise(async (resolve, reject) => {
              try {
                const intervalHandle = setInterval(async () => {
                  const deployment = (await k8sAppApi.readNamespacedDeployment('silta-cluster-placeholder-upscaler-proxy', namespace)).body;
                  if (deployment.status.readyReplicas > 0) {
                    console.log("Upscaler proxy deployment is ready")
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
        );
       
        // point service to upscaler proxy pod
        await k8sApi.patchNamespacedService(serviceName, namespace, {
          metadata: {
            annotations: {
              'auto-downscale/down': 'true',
              'auto-downscale/original-type': service.spec.type,
              'auto-downscale/original-selector': JSON.stringify(service.spec.selector),
              'auto-downscale/original-ports': JSON.stringify(service.spec.ports)
            },
            labels: {
              'auto-downscale/redirected': 'true',
            }
          },
          spec: {
            ports: [
              {
                name: 'http',
                port: 80,
                targetPort: 8080,
                protocol: 'TCP'
              }
            ],
          },
        }, undefined, undefined, undefined, undefined, undefined, {
          headers: {
            'Content-Type': 'application/merge-patch+json'
          }
        });

        // replace service selector instead of patching it
        const patch = [
          {
            "op": "replace",
            "path":"/spec/selector",
            "value": {
                "app": "silta-cluster-placeholder-upscaler-proxy"
            }
          }
        ];
        const options = { "headers": { "Content-type": k8s.PatchUtils.PATCH_FORMAT_JSON_PATCH}};
        await k8sApi.patchNamespacedService(serviceName, namespace, patch, undefined, undefined, undefined, undefined, undefined, options);
      
        console.log(`Redirected service ${namespace}/${serviceName} to placeholder service`);
      }
    }
    catch (error) {
      console.error(`Error updating ${namespace}/${serviceName}`, error);
    }
  };

  async resetService(serviceName, namespace) {
    console.log(`resetService: Resetting service to original ${namespace}/${serviceName}`);

    const service = (await k8sApi.readNamespacedService(serviceName, namespace)).body;

    // if service is not redirected, do nothing
    if (!service.metadata.annotations || service.metadata.annotations['auto-downscale/down'] != 'true') {
      return;
    }

    // try / catch parse original selector
    let originalSelector = {};
    try {
      originalSelector = JSON.parse(service.metadata.annotations['auto-downscale/original-selector']);
    }
    catch (e) {
      console.log(`resetService: Error parsing original selector for ${namespace}/${serviceName}`, e);
      return;
    }

    let originalPorts = service.spec.ports;
    // Old downscales did not set ports. If original ports are not set, use current ports.
    if (service.metadata.annotations['auto-downscale/original-ports']) {
      originalPorts = JSON.parse(service.metadata.annotations['auto-downscale/original-ports']);
    }

    // Old downscales used to set type to ExternalName. 
    // We will tackle that case separately since some load balancers (nginx) do not support ExternalName updates.
    // We'll just recreate the service instead of patching, so ingress update gets triggered.
    if (service.spec.type == 'ExternalName') {
      await k8sApi.deleteNamespacedService(serviceName, namespace);
      // Recreate service with original definition and change type
      let newService = {
        metadata: {
          name: serviceName,
          namespace: namespace,
          annotations: service.metadata.annotations,
          labels: service.metadata.labels,
        },
        spec: service.spec
      };
      newService.metadata.annotations['auto-downscale/down'] = null;
      newService.metadata.annotations['auto-downscale/original-type'] = null;
      newService.metadata.annotations['auto-downscale/original-selector'] = null;
      newService.metadata.annotations['auto-downscale/original-ports'] = null;
      newService.metadata.labels['auto-downscale/redirected'] = null;

      newService.spec.type = service.metadata.annotations['auto-downscale/original-type'];
      newService.spec.externalName = null;
      newService.spec.selector = originalSelector;
      newService.spec.ports = originalPorts;
        
      await k8sApi.createNamespacedService(namespace, newService);
    }

    // New downscales retain type and only switch selector
    else {
      await k8sApi.patchNamespacedService(serviceName, namespace, {
        metadata: {
          annotations: {
            'auto-downscale/down': null,
            'auto-downscale/original-type': null,
            'auto-downscale/original-selector': null,
            'auto-downscale/original-ports': null
          },
          labels: {
            'auto-downscale/redirected': null,
          }
        },
        spec: {
          type: service.metadata.annotations['auto-downscale/original-type'],
          externalName: null,
          selector: originalSelector,
          ports: originalPorts,
        }
      }, undefined, undefined, undefined, undefined, undefined, {
        headers: {
          'Content-Type': 'application/merge-patch+json'
        }
      });
    }

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
    }, undefined, undefined, undefined, undefined, undefined, {
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
    }, undefined, undefined, undefined, undefined, undefined, {
      headers: {
        'Content-Type': 'application/merge-patch+json'
      }
    });

    console.log(`Marked ingress ${namespace}/${ingressName} as down`);
  }

  async getResourceStatus(resource, kind) {
    const name = resource.metadata.name;

    // TODO: use class name instead of explicit "kind" parameter
    // console.log(resoewurce.constructor.name);

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
          }, undefined, undefined, undefined, undefined, undefined, {
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
          }, undefined, undefined, undefined, undefined, undefined, {
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
          }, undefined, undefined, undefined, undefined, undefined, {
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
          }, undefined, undefined, undefined, undefined, undefined, {
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

  // Remove upscaler-proxy deployment if no services are using it.
  async removeUpscalerProxy(namespace) {
    try {
      
      // Query services in namespace with selector 'auto-downscale/redirected=true'
      const services = await k8sApi.listNamespacedService(namespace, undefined, undefined, undefined, undefined, 'auto-downscale/redirected=true');

      // If no services point to it, delete silta-cluster-placeholder-upscaler-proxy deployment
      if (services.body.items.length === 0) {
 
        // Delete silta-cluster-placeholder-upscaler-proxy deployment only if it exists
        try {
          await k8sAppApi.deleteNamespacedDeployment('silta-cluster-placeholder-upscaler-proxy', namespace);
          console.log(`Removed upscaler proxy in ${namespace}`);
        } catch (error) {
          // Skip error if deployment does not exist
          if (error.response.statusCode !== 404) {
            console.log(`Error while removing upscaler proxy in ${namespace}`, error.message);
            throw error;
          }
        }
      }
    }
    catch (error) {
      console.error(`Error while removing upscaler proxy in ${namespace}`, error.message);
    }
  };
  
};

module.exports = new K8sResourceManager();
