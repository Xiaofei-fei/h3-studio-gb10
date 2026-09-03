FROM h3-studio:gb10

USER root

COPY cloudflare-connector/doh-dns-proxy.mjs /doh-dns-proxy.mjs

ENTRYPOINT ["node", "/doh-dns-proxy.mjs"]
