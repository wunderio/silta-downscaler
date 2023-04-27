FROM nginxinc/nginx-unprivileged:1.23.4-alpine-slim

# nginx runs envsubst on templates
COPY conf/nginx-default.conf /etc/nginx/templates/default.conf.template

EXPOSE 8080
