#!/bin/bash

set -e

cd /root/aws-terraform-agent

npm install

pm2 delete ai-agent || true

pm2 start backend/server.js --name ai-agent

pm2 save
