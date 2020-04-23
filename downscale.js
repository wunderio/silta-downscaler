const k8s = require('@kubernetes/client-node');
const moment = require('moment');

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sExtensionsApi = kc.makeApiClient(k8s.ExtensionsV1beta1Api);

const k8sResourceManager = require('./src/k8sResourceManager');

const defaultMinAge = process.env.DEFAULT_MIN_AGE;
const releaseMinAge = JSON.parse(process.env.RELEASE_MIN_AGE);

(async function main() {
  try {
    const ingresses = (await k8sExtensionsApi.listIngressForAllNamespaces()).body.items;

    ingresses
      .filter(ingress => ingress.metadata.annotations)
      .filter(ingress => ingress.metadata.annotations['auto-downscale/last-update'])
      .filter(ingress => {
        const lastUpdate = moment(ingress.metadata.annotations['auto-downscale/last-update']);
        const name = ingress.metadata.name;
        let minAge = defaultMinAge;

        for (let regex in releaseMinAge) {
          if (name.match(new RegExp(regex))) {
            minAge = releaseMinAge[regex];
          }
        }

        return lastUpdate.add(...minAge.split(/(\d+)/).filter(match => match)).isBefore(moment());
      })
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
      });
  }
  catch (e) {
    console.error(e);
  }
})();
