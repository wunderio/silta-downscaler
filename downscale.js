const k8s = require('@kubernetes/client-node');
const moment = require('moment');

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sExtensionsApi = kc.makeApiClient(k8s.ExtensionsV1beta1Api);

const placeholderServiceName = process.env.PLACEHOLDER_SERVICE_NAME;
const placeholderServiceNamespace = process.env.PLACEHOLDER_SERVICE_NAMESPACE;

(async function main() {
  try {
    const ingresses = (await k8sExtensionsApi.listIngressForAllNamespaces()).body.items;

    ingresses
      .filter(ingress => ingress.metadata.annotations)
      .filter(ingress => ingress.metadata.annotations['auto-downscale/last-update'])
      .filter(ingress => moment(ingress.metadata.annotations['auto-downscale/last-update']).add(1, 'hour').isBefore(moment()))
      .forEach(async ingress => {

        const namespace = ingress.metadata.namespace;
        const serviceName = ingress.metadata.annotations['auto-downscale/services'];
        const deploymentNames = ingress.metadata.annotations['auto-downscale/deployments'].split(',');

        redirectService(serviceName, namespace);

        deploymentNames.forEach(async deploymentName => {
          downscaleDeployment(deploymentName, namespace);
        });
      })
  }
  catch (e) {
    console.error(e);
  }
})();


async function redirectService(serviceName, namespace) {
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
}

async function downscaleDeployment(deploymentName, namespace) {
  try {
    const deployment = (await k8sExtensionsApi.readNamespacedDeployment(deploymentName, namespace)).body;

    const replicas = deployment.spec.replicas;

    if (replicas > 0) {

      // Downscale the deployment.
      const result = await k8sExtensionsApi.patchNamespacedDeployment(deploymentName, namespace, {
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

      console.log(`Downscaled deployment ${deploymentName} from ${replicas} to 0`);
    }
  }
  catch (error) {
    console.error(`Error while downscaling ${deploymentName}`, error);
  }
}