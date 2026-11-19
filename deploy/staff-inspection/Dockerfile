ARG STAFF_RUNTIME_IMAGE
FROM ${STAFF_RUNTIME_IMAGE}
USER nextjs
COPY --chmod=0444 host.cjs /app/staff-inspection.cjs
CMD ["node", "/app/staff-inspection.cjs"]
