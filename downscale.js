const k8s = require('@kubernetes/client-node');
const moment = require('moment');

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sNetworkApi = kc.makeApiClient(k8s.NetworkingV1beta1Api);

const k8sResourceManager = require('./src/k8sResourceManager');

const defaultMinAge = process.env.DEFAULT_MIN_AGE;
const releaseMinAge = JSON.parse(process.env.RELEASE_MIN_AGE);

(async function main() {
  try {
    const ingresses = (await k8sNetworkApi.listIngressForAllNamespaces()).body.items;

    const selectedIngresses = ingresses
      .filter(ingress => ingress.metadata.annotations)
      .filter(ingress => ingress.metadata.annotations['auto-downscale/last-update'])
      .filter(ingress => ! ingress.metadata.annotations['auto-downscale/down'])
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
      });

    for (const ingress of selectedIngresses) {
      const annotations = ingress.metadata.annotations;
      const name = ingress.metadata.name;
      const namespace = ingress.metadata.namespace;
      const serviceName = annotations['auto-downscale/services'];
      const labelSelector = annotations['auto-downscale/label-selector'];
      await k8sResourceManager.redirectService(serviceName, namespace);
      await k8sResourceManager.markIngressAsDown(name, namespace);

      const {deployments, cronjobs, statefulsets} = await k8sResourceManager.loadResources(namespace, labelSelector);
      for (const deployment of deployments) {
        await k8sResourceManager.downscaleResource(deployment, "deployment");
      }
      for (const cronjob of cronjobs) {
        await k8sResourceManager.downscaleResource(cronjob, "cronjob");
      }
      for (const statefulset of statefulsets) {
        await k8sResourceManager.downscaleResource(statefulset, "statefulset");
      }
    }
  }
  catch (e) {
    console.error(e);
  }
})();
