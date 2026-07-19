# AWS Terraform Multi Resource Self-Service Portal

## Overview

AWS Terraform Multi Resource Self-Service Portal is a web-based provisioning platform that enables users to:

- Generate Terraform code from a UI
- Create AWS resources directly from the portal
- Destroy AWS resources when no longer needed
- Track requests independently
- Maintain Terraform state per request
- Manage multiple AWS resource types

The portal is built using:

- Node.js
- Express.js
- Terraform
- AWS
- PM2
- HTML/CSS/JavaScript

---

# Supported Resources

Currently supported:

✅ EC2

✅ S3

✅ EBS

✅ RDS

✅ VPC

✅ Security Groups

✅ ALB

✅ Route53

✅ ECS

✅ EKS

✅ Lambda

✅ FSx

✅ ElastiCache

            ---
        # Architecture

            User

              ↓

            Web UI

              ↓

          Node.js API

              ↓

        Generate Terraform

              ↓

          Request Folder

              ↓

          Terraform Plan

              ↓

          Terraform Apply

              ↓

          AWS Resources

              ---

# Request Isolation

Each request gets its own folder:

generated/

├── REQ-123456/

│   ├── main.tf

│   ├── request.json

│   ├── status.json

│   ├── plan.log

│   ├── apply.log

│   ├── destroy.log

│   └── terraform.tfstate

├── REQ-123457/

│   ├── main.tf

│   └── ...

This prevents resource conflicts.

---

# Project Structure

aws-terraform-agent/

├── backend/

│   └── server.js

├── public/

│   └── index.html

├── generated/

├── package.json

├── package-lock.json

├── deploy.sh

├── .gitignore

└── README.md

---

# Prerequisites

Amazon Linux 2023

Node.js

Terraform

AWS CLI

PM2

Git

---

# Installing On New Server

## Update Server

sudo dnf update -y

## Install Git

sudo dnf install git -y

---

# Install Node.js

curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

source ~/.bashrc

nvm install --lts

node -v

npm -v

---

# Install PM2

npm install -g pm2

---

# Install Terraform

sudo yum-config-manager \
--add-repo \
https://rpm.releases.hashicorp.com/AmazonLinux/hashicorp.repo

sudo dnf install terraform -y

terraform version

---

# Install AWS CLI

sudo dnf install awscli -y

aws --version

---

# Clone Repository

cd /opt

git clone https://github.com/vikasgaur1992/aws-terraform-agent.git

cd aws-terraform-agent

---

# Install Dependencies

npm install

---

# Create Generated Folder

mkdir -p generated

---

# Configure AWS Access

Option 1 (Recommended)

Attach IAM Role to EC2

No credentials required

Option 2

aws configure

Provide:

AWS Access Key

AWS Secret Key

Region

Output Format

---

# Start Application

pm2 start backend
