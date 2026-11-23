FROM docker.io/library/node@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a
WORKDIR /opt/notices
COPY --chmod=0444 server.mjs privacy.html data-deletion.html ./
USER 1000:1000
CMD ["node", "server.mjs"]
