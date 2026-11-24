#!/bin/sh
# Runs on container start (nginx image feature): expose the API URL to the page.
printf 'window.API_URL = "%s";\n' "${API_URL%/}" > /usr/share/nginx/html/config.js
