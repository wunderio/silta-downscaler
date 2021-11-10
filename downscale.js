const k8s = require('@kubernetes/client-node');
const moment = require('moment');

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sNetworkApi = kc.makeApiClient(k8s.NetworkingV1beta1Api);

const k8sResourceManager = require('./src/k8sResourceManager');

// const defaultMinAge = process.env.DEFAULT_MIN_AGE;
// const releaseMinAge = JSON.parse(process.env.RELEASE_MIN_AGE);

//hardcode env values
const defaultMinAge = "1min";
const releaseMinAge = JSON.parse('{"^(sample-environment|master|main|stage|staging)":"1min","^dependabot":"1h","^production":"10y"}');

// PLACEHOLDER_SERVICE_NAME:       silta-cluster-placeholder-upscaler
// PLACEHOLDER_SERVICE_NAMESPACE:   (v1:metadata.namespace)
// DEFAULT_MIN_AGE:                1h
// RELEASE_MIN_AGE:                {"^(master|main|stage|staging)":"4w","^dependabot":"1h","^production":"10y"}

(async function main() {
  try {
  
    //const ingresses = (await k8sNetworkApi.listIngressForAllNamespaces()).body.items;
    const ingresses = (await k8sNetworkApi.listNamespacedIngress('drupal-project-k8s')).body.items;
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

    console.log('listing ingress call');
    for (const ingress of selectedIngresses) {
      console.log(ingress.metadata.name);
    }
    for (const ingress of selectedIngresses) {
      const annotations = ingress.metadata.annotations;
      const name = ingress.metadata.name;
      const namespace = ingress.metadata.namespace;
      const serviceName = annotations['auto-downscale/services'];
      const labelSelector = annotations['auto-downscale/label-selector'];
      //await k8sResourceManager.redirectService(serviceName, namespace);
      //await k8sResourceManager.markIngressAsDown(name, namespace);
      console.log('\x1b[33m%s\x1b[0m', `Ingress ${name} START`);
      console.log('extractScalableResourcesFromIngress call');
      const {deployments, cronjobs, statefulsets} = await k8sResourceManager.extractScalableResourcesFromIngress(ingress);
      console.log('deployments---');
      for (const deployment of deployments) {
        await k8sResourceManager.downscaleResource(deployment, "deployment");
      }
      console.log('cjs---');
      for (const cronjob of cronjobs) {
        await k8sResourceManager.downscaleResource(cronjob, "cronjob");
      }
      console.log('sts---');
      for (const statefulset of statefulsets) {
        await k8sResourceManager.downscaleResource(statefulset, "statefulset");
      }
      console.log('\x1b[31m%s\x1b[0m', `Ingress ${name} END`);
    }
  }
  catch (e) {
    console.error(e);
  }
})();
