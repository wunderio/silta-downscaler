FROM nginxinc/nginx-unprivileged:1.23.3-alpine-slim

# nginx runs envsubst on templates
COPY conf/nginx-default.conf /etc/nginx/templates/default.conf.template

EXPOSE 8080
