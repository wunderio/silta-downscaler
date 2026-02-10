FROM nginxinc/nginx-unprivileged:1.28.2-alpine-slim

# nginx runs envsubst on templates
COPY conf/nginx-default.conf /etc/nginx/templates/default.conf.template

COPY html/rate-limit.html /usr/share/nginx/html/rate-limit.html

EXPOSE 8080
