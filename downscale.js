const k8s = require('@kubernetes/client-node');
const moment = require('moment');

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sNetworkApi = kc.makeApiClient(k8s.NetworkingV1Api);

const k8sResourceManager = require('./src/k8sResourceManager');

const defaultMinAge = process.env.DEFAULT_MIN_AGE;
const releaseMinAge = JSON.parse(process.env.RELEASE_MIN_AGE);
const placeholderServiceName = process.env.PLACEHOLDER_SERVICE_NAME;
const placeholderServiceNamespace = process.env.PLACEHOLDER_SERVICE_NAMESPACE;
const placeholderProxyImage = process.env.PLACEHOLDER_PROXY_IMAGE;

(async function main() {
  
  // Required env vars
  if (!defaultMinAge) {
    throw new Error("Missing DEFAULT_MIN_AGE");
  }
  if (!placeholderServiceName) {
    throw new Error("Missing PLACEHOLDER_SERVICE_NAME");
  }
  if (!placeholderServiceNamespace) {
    throw new Error("Missing PLACEHOLDER_SERVICE_NAMESPACE");
  }
  if (!placeholderProxyImage) {
    throw new Error("Missing PLACEHOLDER_PROXY_IMAGE");
  }
  
  try {

    const ingresses = (await k8sNetworkApi.listIngressForAllNamespaces()).items;
    const selectedIngresses = ingresses
      .filter(ingress => ingress.metadata.annotations)
      .filter(ingress => ingress.metadata.annotations['auto-downscale/last-update'])
      .filter(ingress => ! ingress.metadata.annotations['auto-downscale/down'] || ingress.metadata.annotations['auto-downscale/down'] == "false")
      .filter(ingress => {
        const lastUpdate = moment(ingress.metadata.annotations['auto-downscale/last-update']);
        const name = ingress.metadata.name;
        let minAge = defaultMinAge;
        // check if custom min-age annotation is present.
        if ('auto-downscale/min-age' in ingress.metadata.annotations) {
          minAge = ingress.metadata.annotations['auto-downscale/min-age'];
        } else {
          for (let regex in releaseMinAge) {
            if (name.match(new RegExp(regex))) {
              minAge = releaseMinAge[regex];
            }
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
      const {deployments, cronjobs, statefulsets} = await k8sResourceManager.extractScalableResourcesFromIngress(ingress);
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
