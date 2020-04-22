const k8s = require('@kubernetes/client-node');
const moment = require('moment');

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sExtensionsApi = kc.makeApiClient(k8s.ExtensionsV1beta1Api);

const k8sResourceManager = require('./src/k8sResourceManager');

(async function main() {
  try {
    const ingresses = (await k8sExtensionsApi.listIngressForAllNamespaces()).body.items;

    ingresses
      .filter(ingress => ingress.metadata.annotations)
      .filter(ingress => ingress.metadata.annotations['auto-downscale/last-update'])
      // .filter(ingress => moment(ingress.metadata.annotations['auto-downscale/last-update']).add(1, 'hour').isBefore(moment()))
      .forEach(async ingress => {

        const annotations = ingress.metadata.annotations;
        const namespace = ingress.metadata.namespace;
        const serviceName = annotations['auto-downscale/services'];
        const labelSelector = annotations['auto-downscale/label-selector'];
        k8sResourceManager.redirectService(serviceName, namespace);

        const {deployments, cronjobs, statefulsets} = await k8sResourceManager.loadResources(namespace, labelSelector);
        deployments.forEach(deployment => k8sResourceManager.downscaleResource(deployment, "deployment"));
        cronjobs.forEach(cronjob => k8sResourceManager.downscaleResource(cronjob, "cronjob"));
        statefulsets.forEach(statefulset => k8sResourceManager.downscaleResource(statefulset, "statefulset"));

        console.log(moment(annotations['auto-downscale/last-update']).add(1, 'hour').isBefore(moment()));
      });
  }
  catch (e) {
    console.error(e);
  }
})();
