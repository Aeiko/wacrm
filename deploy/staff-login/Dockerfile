ARG LOGIN_RUNTIME_IMAGE
FROM ${LOGIN_RUNTIME_IMAGE}
USER 1000:1000
COPY --chmod=0444 login-gateway.mjs /opt/login-gateway.mjs
CMD ["node", "/opt/login-gateway.mjs"]
