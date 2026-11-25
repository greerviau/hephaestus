# A machine with systemd as PID 1, so install and uninstall run against a real
# systemd user manager.
FROM node:22-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session curl \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g npm@11.6.2 \
  && useradd --create-home --shell /bin/bash owner

WORKDIR /opt/hephaestus
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev
COPY test/container/scenario.sh /usr/local/bin/scenario.sh

STOPSIGNAL SIGRTMIN+3
CMD ["/lib/systemd/systemd"]
