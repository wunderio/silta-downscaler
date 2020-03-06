

# Silta downscaler

The Silta downscaler watches for ingresses with specific annotations in your cluster, 
which points to deployments that can be downscaled. When an application is downscaled, 
the service used as the main entrypoint to it is redirected to a placeholder page from
which the application can be scaled back up.

The Silta downscaler is obviously meant for use on non-production clusters.

 