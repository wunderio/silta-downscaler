const express = require('express');
const cors = require('cors');
const app = express();
const port = 3000;

const k8s = require('@kubernetes/client-node');

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const k8sApi = kc.makeApiClient(k8s.CoreV1Api);
const k8sNetworkApi = kc.makeApiClient(k8s.NetworkingV1Api);

const placeholderDomain = process.env.PLACEHOLDER_DOMAIN;

const k8sResourceManager = require('./src/k8sResourceManager');

const badUserAgents = process.env.BAD_USERAGENTS;
var badUserAgentsArray;

if (typeof badUserAgents !== 'undefined'){
  badUserAgentsArray = badUserAgents.split(";");
}

app.use(cors());

/**
 * Trigger an application to be scaled back up, identified by the domain of its ingress.
 */
app.post('/upscale', async (req, res) => {
  try {
    if (blockBadActors(req)) {
      res.sendStatus(403).end();
      return;
    }
    const ingress = await loadIngressByHostname(req.query.domain);

    if (ingress) {
      const name = ingress.metadata.name;
      const namespace = ingress.metadata.namespace;
      const annotations = ingress.metadata.annotations;
      
      if (annotations['auto-downscale/down']) {

        const labelSelector = annotations['auto-downscale/label-selector'];
        const serviceName = ingress.metadata.annotations['auto-downscale/services'];

        const {deployments, cronjobs, statefulsets} = await k8sResourceManager.extractScalableResourcesFromIngress(ingress);

        await Promise.all([
          ...deployments.map(deployment => k8sResourceManager.upscaleResource(deployment, 'deployment')),
          ...cronjobs.map(cronjob => k8sResourceManager.upscaleResource(cronjob, 'cronjob')),
          ...statefulsets.map(statefulset => k8sResourceManager.upscaleResource(statefulset, 'statefulset')),
          k8sResourceManager.updateIngressLastUpdate(name, namespace)
        ]);

        // TODO: update ingress and switch service only after all resources are ready?

        // Send the response immediately, before the deployments are ready.
        res.json({message: `${ingress.metadata.name} triggered`});

        await k8sResourceManager.waitForResourcesReady(namespace, labelSelector);
        var labelSelector2 = labelSelector.replace("release=","app.kubernetes.io/instance=");
        await k8sResourceManager.waitForResourcesReady(namespace, labelSelector2);

        // Once the deployments are ready, reset the service.
        await k8sResourceManager.resetService(serviceName, namespace);

        // Remove upscaler proxy pod if no services in namespace are pointing to it
        k8sResourceManager.removeUpscalerProxy(namespace);
      }
      else {
        console.log(`Someone tried to upscale ${req.query.domain} via ingress/${name}`)
        res.sendStatus(404);
      }
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
      const labelSelector1 = annotations['auto-downscale/label-selector'];
      var resourceStatus = await k8sResourceManager.loadResourcesStatus(namespace, labelSelector1);
      var labelSelector2 = labelSelector1.replace("release=","app.kubernetes.io/instance=");
      const resourceStatus2 = await k8sResourceManager.loadResourcesStatus(namespace, labelSelector2);
      const service = (await k8sApi.readNamespacedService({ name: serviceName, namespace: namespace }));

      // Merge resourceStatus2 into resourceStatus based on name key
      resourceStatus2.forEach(function (item2) {
        var found = resourceStatus.some(element => {
          if (element.name === item2.name) return true;
          else return false;
        });
        if (!found) {
          resourceStatus.push(item2)
        }
      });

      // Wait for resources to be ready
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
  if (blockBadActors(req)) {
    res.sendStatus(403).end();
    return;
  }
  try {
    // Strip off the port when used locally.
    const hostname = req.headers.host.replace(':3000', '');
    const currentIngress = await loadIngressByHostname(hostname);
    if (currentIngress) {
      const annotations = currentIngress.metadata.annotations;
      if (annotations['auto-downscale/down']) {
        console.log(`Showing placeholder for ${hostname}`)
        // always send header "x-robots-tag"
        res.append("x-robots-tag", "noindex, nofollow, nosnippet, noarchive")
        // set response status to 404, but do show :Launch" button
        res.status(404).send(placeholderPageContent(hostname, currentIngress.metadata.name));
      }
      else {
        res.sendStatus(404);
      }
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
  const ingresses = (await k8sNetworkApi.listIngressForAllNamespaces()).items;
  return ingresses.find(ingress => ingress.spec.rules.some(rule => rule.host === hostname));
}

function blockBadActors(req) {
  if (typeof badUserAgents !== 'undefined'){
    badUserAgentsArray.forEach(function(uaString){
      if (req.get('User-Agent') && req.get('User-Agent').includes(uaString)) {
        // Print ip address of the request and sanitized user agent
        console.log(`Blocked request from ${req.ip} with user agent ${req.get('User-Agent').replace(/[^a-zA-Z0-9]/g, '')}`);
        return true;
      }
    });
  }
  return false;
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
      /* Source of spinner: https://loading.io/css/ */
      .lds-ring {
        display: inline-block;
        position: relative;
        width: 1.3em;
        height: 1.3em;
        margin-right: 1px;
      }
      .lds-ring div {
        box-sizing: border-box;
        display: block;
        position: absolute;
        width: 1em;
        height: 1em;
        margin: 2px;
        border: 2px solid #5b37bf;
        border-radius: 50%;
        animation: lds-ring 1.8s cubic-bezier(0.5, 0, 0.5, 1) infinite;
        border-color: #5b37bf transparent transparent transparent;
      }
      .lds-ring div:nth-child(1) {
        animation-delay: -0.45s;
      }
      .lds-ring div:nth-child(2) {
        animation-delay: -0.3s;
      }
      .lds-ring div:nth-child(3) {
        animation-delay: -0.15s;
      }
      @keyframes lds-ring {
        0% {
          transform: rotate(0deg);
        }
        100% {
          transform: rotate(360deg);
        }
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
            const details = data.resourceStatus.map(resource => '<li>' + resource.name + " " + (resource.isReady ? "✅" : '<div class="lds-ring"><div></div><div></div><div></div><div></div></div>') + '</li>').join('');
            document.getElementById("progress").innerHTML = '<ul>' + details + '</ul>';
          }
        }, 5000);
      }
    </script>
</body>
</html>
`;
}
