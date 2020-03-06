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

app.use(cors());

/**
 * Trigger an application to be scaled back up, identified by the domain of its ingress.
 */
app.post('/upscale', async (req, res) => {
  try {
    const ingress = await loadIngressByHostname(req.query.domain);

    if (ingress) {
      const namespace = ingress.metadata.namespace;
      const serviceName = ingress.metadata.annotations['auto-downscale/services'];
      const deploymentNames = ingress.metadata.annotations['auto-downscale/deployments'].split(',');

      await Promise.all(deploymentNames.map(async deploymentName => {
        await upscaleDeployment(deploymentName, namespace);
      }));

      // Send the response immediately, before the deployments are ready.
      res.json({message: `${ingress.metadata.name} triggered`});

      await Promise.all(deploymentNames.map(async deploymentName => {
        await waitForDeploymentReady(deploymentName, namespace);
      }));

      // Once the deployments are ready, reset the service.
      await resetService(serviceName, namespace);
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
      const namespace = ingress.metadata.namespace;
      const serviceName = ingress.metadata.annotations['auto-downscale/services'];
      const deploymentNames = ingress.metadata.annotations['auto-downscale/deployments'].split(',');

      const statusDetails = await Promise.all(
        deploymentNames.map(async deploymentName => {
          const deployment = (await k8sExtensionsApi.readNamespacedDeploymentStatus(deploymentName, namespace)).body;

          const desiredReplicas = deployment.spec.replicas;
          const currentReplicas = deployment.status.readyReplicas || 0;

          return {
            name: deploymentName,
            type: 'deployment',
            message: `${currentReplicas} / ${desiredReplicas}`,
            desiredCount: desiredReplicas,
            readyCount: currentReplicas,
            isReady: currentReplicas === desiredReplicas,
          };
        })
      );

      const service = (await k8sApi.readNamespacedService(serviceName, namespace)).body;

      res.json({
        details: statusDetails,
        percentage: 100 * statusDetails.reduce((sum, detail) => sum + detail.readyCount, 0) / statusDetails.reduce((sum, detail) => sum + detail.desiredCount, 0),
        done: statusDetails.every(detail => detail.isReady) && (!service.metadata.annotations || service.metadata.annotations['auto-downscale/down'] != 'true'),
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
  try {
    // Strip off the port when used locally.
    const hostname = req.headers.host.replace(':3000', '');
    const currentIngress = await loadIngressByHostname(hostname);

    if (currentIngress) {
      res.sent(placeholderPageContent(hostname, currentIngress.metadata.name));
    }
    else {
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

async function upscaleDeployment(deploymentName, namespace) {
  const deployment = (await k8sExtensionsApi.readNamespacedDeployment(deploymentName, namespace)).body;
  const desiredReplicas = parseInt(deployment.metadata.annotations['auto-downscale/original-replicas']) || 1;

  console.log(`Requesting to scale ${deploymentName} to ${desiredReplicas} replica(s)`);

  const result = await k8sExtensionsApi.patchNamespacedDeployment(deploymentName, namespace, {
    metadata: {
      annotations: {
        'auto-downscale/original-replicas': null
      }
    },
    spec: {
      replicas: desiredReplicas
    }
  }, undefined, undefined, undefined, undefined, {
    headers: {
      'Content-Type': 'application/merge-patch+json'
    }
  });
}

async function waitForDeploymentReady(deploymentName, namespace) {
  // TODO: find a better wait mechanism, with a timeout.
  while (true) {
    const deployment = (await k8sExtensionsApi.readNamespacedDeploymentStatus(deploymentName, namespace)).body;

    if (deployment.status.readyReplicas == deployment.replicas) break;
  }
}

async function resetService(serviceName, namespace) {
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

function placeholderPageContent(hostname, ingressName) {
  return
`<!DOCTYPE html>
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
          margin-bottom: 10%;
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
          height: 20px;  /* Can be anything */
          position: relative;
          background: #E7E6EB;
          -moz-border-radius: 25px;
          -webkit-border-radius: 25px;
          border-radius: 25px;
          box-shadow: inset 0 -1px 1px rgba(255,255,255,0.3);
          width: 40%;
          margin: auto;
      }
      #progressBar {
          display: block;
          height: 100%;
          width: 0%;
          background-color: #5B37BF;
          border-radius: 25px;
          position: relative;
          overflow: hidden;
      }
      #progressPercentage {
          width:100%;
          height:30px;
          line-height:30px;
          position:absolute;
          top:15px;
          left:0px;
          color: #5B37BF;
          font-weight: bold;
      }
    </style>
    
</head>
<body>

<h2>The environment ${ingressName} is on standby</h2>
        <div id="progress">
            <div id="progressBar"></div>
            <div id="progressPercentage"></div>
</div>
<button id="myBtn" onclick="reLaunch()">Launch</button>
<script>
      document.getElementById("progress").style.display = "none";
      
      async function reLaunch() {
        // Hide the button and show the progress bar.
        document.getElementById("myBtn").style.display = "none";
        document.getElementById("progress").style.display = "block";
        
        const response = await fetch('//${placeholderDomain}/upscale?domain=${hostname}', {method: 'post'});
        console.log(response);
        
        const Change = setInterval(async function () {
          const response = await fetch('//${placeholderDomain}/status?domain=${hostname}');
          const data = await response.json();
          
          if (data.done) {
            clearInterval(Change);
            window.location.reload();
          }
          else {
            const percentage = data.percentage;
            document.getElementById("progressPercentage").innerHTML = percentage.toString() + "%";
            document.getElementById("progressBar").style.width = percentage + "%";
          }
        }, 5000);
      }
    </script>
</body>
</html>
`;
}