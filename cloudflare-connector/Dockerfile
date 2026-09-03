FROM scratch

COPY bin/cloudflared /cloudflared
COPY cloudflare-connector/cloudflared-resolv.conf /etc/resolv.conf

ENTRYPOINT ["/cloudflared"]
