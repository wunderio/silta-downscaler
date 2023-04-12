# Silta downscaler

## About

Silta downscaler is a set of two applications that allows saving resources by suspending 
deployments on a time based schedule.
- `downscaler.js` is a cronjob initiated process that selects Ingress resources with special 
annotations in your cluster, marking deployments that can be downscaled. 
When an application is downscaled, kubernetes service type is changed to `externalName` and 
pointed to placeholder site.
- `index.js`, provides placeholder site that allows downscaled application to 
be be scaled back up.

The Silta downscaler is, obviously, meant for use on non-production clusters.

## Supported versions

- Networking API V1 is only available since kubernetes v1.19. Older versions of downscaler support older kubernetes versions.

## Development

Downscaler cronjob test:
```bash
PLACEHOLDER_SERVICE_NAME=silta-cluster-placeholder-upscaler \
PLACEHOLDER_SERVICE_NAMESPACE=silta-cluster \
PLACEHOLDER_PROXY_IMAGE=wunderio/silta-downscaler:v0.2-proxy \
DEFAULT_MIN_AGE=1h \
RELEASE_MIN_AGE='{"^(dev|develop|development)":"2w","^(master|main|stage|staging)":"4w","^dependabot":"1h","^production":"10y"}' \
node downscale.js
```

Terminal log from downscaler.js
```
Marked ingress drupal-project-k8s/cli-test-drupal as down
Downscaled deployment drupal-project-k8s/cli-test-drupal from 1 to 0
Downscaled deployment drupal-project-k8s/cli-test-shell from 1 to 0
Suspended cronjob drupal-project-k8s/cli-test-cron-drupal
Downscaled statefulset drupal-project-k8s/cli-test-mariadb from 1 to 0
```

Placeholder site test:
```bash
node index.js
```

```bash
curl -X POST "http://localhost:3000/upscale?domain=cli-test.drupal-project-k8s.[cluster-domain]
# Successful response:
# {"message":"cli-test-drupal triggered"}

# Repeated or incorrect request response
# Not Found
```

Terminal log from `index.js`
```
node ./index.js
Example app listening on port 3000!
Requesting to scale cli-test-drupal to 1 replica(s)
Requesting to scale cli-test-shell to 1 replica(s)
Requesting to scale cli-test-mariadb to 1 replica(s)
Updated last-update annotation on drupal-project-k8s/cli-test-drupal ingress
Unsuspended cronjob drupal-project-k8s/cli-test-cron-drupal
Upscaled deployment drupal-project-k8s/cli-test-shell from 0 to 1
Upscaled statefulset drupal-project-k8s/cli-test-mariadb from 0 to 1
Upscaled deployment drupal-project-k8s/cli-test-drupal from 0 to 1
drupal-project-k8s/release=cli-test selector resources are ready
drupal-project-k8s/app.kubernetes.io/instance=cli-test selector resources are ready
Reset service drupal-project-k8s/cli-test-drupal to original service
Someone tried to upscale cli-test.drupal-project-k8s.[cluster-domain] via ingress/cli-test-drupal
```

Docker image build
```
docker build --tag 'wunderio/silta-downscaler:latest' --tag 'wunderio/silta-downscaler:v0.2' --tag 'wunderio/silta-downscaler:v0.2.X' .
docker push wunderio/silta-downscaler:latest 
docker push wunderio/silta-downscaler:v0.2 
docker push wunderio/silta-downscaler:v0.2.X
```
