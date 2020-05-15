const express = require('express');
const cors = require('cors');
const app = express();
const port = 3000;

const k8s = require('@kubernetes/client-node');

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sExtensionsApi = kc.makeApiClient(k8s.ExtensionsV1beta1Api);

const placeholderDomain = process.env.PLACEHOLDER_DOMAIN;

const k8sResourceManager = require('./src/k8sResourceManager');

app.use(cors());

/**
 * Trigger an application to be scaled back up, identified by the domain of its ingress.
 */
app.post('/upscale', async (req, res) => {
  try {
    console.log(req.query.domain);
    const ingress = await loadIngressByHostname(req.query.domain);

    if (ingress) {
      const name = ingress.metadata.name;
      const namespace = ingress.metadata.namespace;
      const annotations = ingress.metadata.annotations;
      const labelSelector = annotations['auto-downscale/label-selector'];
      const serviceName = ingress.metadata.annotations['auto-downscale/services'];

      const {deployments, cronjobs, statefulsets} = await k8sResourceManager.loadResources(namespace, labelSelector);

      await Promise.all([
        ...deployments.map(deployment => k8sResourceManager.upscaleResource(deployment, 'deployment')),
        ...cronjobs.map(cronjob => k8sResourceManager.upscaleResource(cronjob, 'cronjob')),
        ...statefulsets.map(statefulset => k8sResourceManager.upscaleResource(statefulset, 'statefulset')),
        k8sResourceManager.updateIngressLastUpdate(name, namespace)
      ]);

      // Send the response immediately, before the deployments are ready.
      res.json({message: `${ingress.metadata.name} triggered`});

      await k8sResourceManager.waitForResourcesReady(namespace, labelSelector);

      // Once the deployments are ready, reset the service.
      await k8sResourceManager.resetService(serviceName, namespace);
    }
    else {
      res.sendStatus(404);
    }
  }
  catch(error) {
    console.error(error);
  }
});

/**
 * Get the upscaling status of an application.
 */
app.get('/status', async (req, res) => {
  try {
    const ingress = await loadIngressByHostname(req.query.domain);

    if (ingress) {
      const annotations = ingress.metadata.annotations;
      const namespace = ingress.metadata.namespace;
      const serviceName = annotations['auto-downscale/services'];
      const labelSelector = annotations['auto-downscale/label-selector'];
      const resourceStatus = await k8sResourceManager.loadResourcesStatus(namespace, labelSelector);
      const service = (await k8sApi.readNamespacedService(serviceName, namespace)).body;

      res.json({
        done: resourceStatus.every(resource => resource.isReady) && (!service.metadata.annotations || service.metadata.annotations['auto-downscale/down'] != 'true'),
        resourceStatus,
        service: service.status
      });
    }
    else {
      res.sendStatus(404);
    }
  }
  catch (e) {
    console.error(e);
  }
});

app.get('*', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  try {
    // Strip off the port when used locally.
    const hostname = req.headers.host.replace(':3000', '');
    const currentIngress = await loadIngressByHostname(hostname);

    if (currentIngress) {
      console.log(`Showing placeholder for ${hostname}`)
      res.send(placeholderPageContent(hostname, currentIngress.metadata.name));
    }
    else {
      console.log(`No ingress found for ${hostname}`)
      res.sendStatus(404);
    }
  }
  catch(error) {
    console.error(error);
  }
});

app.listen(port, () => console.log(`Example app listening on port ${port}!`));

async function loadIngressByHostname(hostname) {
  const ingresses = (await k8sExtensionsApi.listIngressForAllNamespaces()).body.items;
  return ingresses.find(ingress => ingress.spec.rules.some(rule => rule.host === hostname));
}

function placeholderPageContent(hostname, ingressName) {
  return `<!DOCTYPE html>
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <!-- Suppress browser request for favicon.ico -->
    <link rel="shortcut icon"type="image/x-icon" href="data:image/x-icon;,">
    <style>
      body {
          font-family: "Overpass",sans-serif;
          text-align: center;
      }
      h2 {
          text-align: center;
          font-size: 20px;
          margin: 100px;
          color: #5b37bf;
          font-weight: 800;
      }
      button#myBtn {
          display: inline-block;
          min-width: 12.5rem;
          padding: 1rem;
          color: #fff;
          line-height: 1.35;
          background: #5b37bf;
          border: 0;
          border-radius: 3px;
          -webkit-transition: background-color .3s;
          transition: background-color .3s;
          cursor: pointer;
          font-size: 16px;
      }
      #progress {
          width: 400px;
          margin: auto;
      }
      #progress ul {
        list-style: none;
        text-align: right;
      }
    </style>
    
</head>
<body>

<h2>The environment ${ingressName} is on standby</h2>
<button id="myBtn" onclick="reLaunch()">Launch</button>
<div id="timer"></div>
<div id="progress"></div>
<script>
      async function reLaunch() {
        // Start timer
        const start = new Date().getTime();
        const timerHandle = setInterval(async function () {
          const difference = new Date().getTime() - start;
          document.getElementById("timer").innerHTML = Math.floor(difference/60000) + ':' + String(Math.floor(difference/1000) % 60).padStart(2, 0);
        }, 1000);
        
        // Hide the button.
        document.getElementById("myBtn").style.display = "none";
        
        const response = await fetch('//${placeholderDomain}/upscale?domain=${hostname}', {method: 'post'});
        
        const progressHandle = setInterval(async function () {
          const response = await fetch('//${placeholderDomain}/status?domain=${hostname}');
          const data = await response.json();
          
          if (data.done) {
            clearInterval(progressHandle);
            setTimeout(() => {
              document.getElementById("progress").innerHTML = 'Reloading...';
              window.location.reload();
            }, 2000);
          }
          else {
            const details = data.resourceStatus.map(resource => '<li>' + resource.name + " " + (resource.isReady ? "✅" : "🔄") + '</li>').join('');
            document.getElementById("progress").innerHTML = '<ul>' + details + '</ul>';
          }
        }, 5000);
      }
    </script>
</body>
</html>
`;
}
