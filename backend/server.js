const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { execSync } = require('child_process');

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const BASE_DIR = path.join(__dirname, '../generated');

if (!fs.existsSync(BASE_DIR)) {
    fs.mkdirSync(BASE_DIR, { recursive: true });
}

function safeName(value, fallback) {
    const input = String(value || fallback || 'resource');
    return input
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || fallback || 'resource';
}

function tfName(value) {
    return safeName(value, 'resource').replace(/-/g, '_');
}

function q(value) {
    return `"${String(value || '').replace(/"/g, '\\"')}"`;
}

function csv(value) {
    return String(value || '')
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
}

function hclList(value) {
    return `[${csv(value).map(q).join(', ')}]`;
}

function boolValue(value, defaultValue) {
    if (value === true || value === 'true' || value === 'yes' || value === 'on') {
        return 'true';
    }
    if (value === false || value === 'false' || value === 'no' || value === 'off') {
        return 'false';
    }
    return defaultValue ? 'true' : 'false';
}

function numValue(value, defaultValue) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) {
        return n;
    }
    return defaultValue;
}

function providerBlock(data) {
    const region = data.region || 'us-east-1';

    return `terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = ${q(region)}
}

`;
}

function commonTags(data) {
    return `  tags = {
    Name        = ${q(data.name || 'terraform-resource')}
    Environment = ${q(data.environment || 'dev')}
    Owner       = ${q(data.owner || 'terraform-agent')}
    ManagedBy   = "Terraform"
  }`;
}

function buildEc2(data) {
    const name = tfName(data.name);
    const rootVolumeSize = numValue(data.rootVolumeSize, 30);
    const rootVolumeType = data.rootVolumeType || 'gp3';
    const additionalVolumeSize = Number(data.additionalVolumeSize || 0);
    const additionalVolumeType = data.additionalVolumeType || 'gp3';
    const deviceName = data.deviceName || '/dev/sdf';

    let terraform = `${providerBlock(data)}resource "aws_instance" "${name}" {
  ami           = ${q(data.ami)}
  instance_type = ${q(data.instanceType || 't3.micro')}
  subnet_id     = ${q(data.subnetId)}

`;

    if (data.keyName) {
        terraform += `  key_name = ${q(data.keyName)}

`;
    }

    if (data.securityGroupIds) {
        terraform += `  vpc_security_group_ids = ${hclList(data.securityGroupIds)}

`;
    }

    terraform += `  root_block_device {
    volume_size = ${rootVolumeSize}
    volume_type = ${q(rootVolumeType)}
    encrypted   = true
  }

${commonTags(data)}
}

output "instance_id" {
  value = aws_instance.${name}.id
}

output "private_ip" {
  value = aws_instance.${name}.private_ip
}

output "public_ip" {
  value = aws_instance.${name}.public_ip
}

`;

    if (additionalVolumeSize > 0) {
        terraform += `resource "aws_ebs_volume" "${name}_data" {
  availability_zone = aws_instance.${name}.availability_zone
  size              = ${additionalVolumeSize}
  type              = ${q(additionalVolumeType)}
  encrypted         = true

${commonTags({
            ...data,
            name: `${data.name || 'terraform-resource'}-data-volume`
        })}
}

resource "aws_volume_attachment" "${name}_data_attach" {
  device_name = ${q(deviceName)}
  volume_id   = aws_ebs_volume.${name}_data.id
  instance_id = aws_instance.${name}.id
}

`;
    }

    return terraform;
}

function buildS3(data) {
    const name = tfName(data.bucketName || data.name);
    const bucketName = data.bucketName || `${safeName(data.name)}-${Date.now()}`;

    return `${providerBlock(data)}resource "aws_s3_bucket" "${name}" {
  bucket = ${q(bucketName)}

${commonTags(data)}
}

resource "aws_s3_bucket_public_access_block" "${name}" {
  bucket                  = aws_s3_bucket.${name}.id
  block_public_acls       = ${boolValue(data.blockPublicAccess, true)}
  block_public_policy     = ${boolValue(data.blockPublicAccess, true)}
  ignore_public_acls      = ${boolValue(data.blockPublicAccess, true)}
  restrict_public_buckets = ${boolValue(data.blockPublicAccess, true)}
}

resource "aws_s3_bucket_versioning" "${name}" {
  bucket = aws_s3_bucket.${name}.id

  versioning_configuration {
    status = ${data.versioning === 'false' ? '"Suspended"' : '"Enabled"'}
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "${name}" {
  bucket = aws_s3_bucket.${name}.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

output "bucket_name" {
  value = aws_s3_bucket.${name}.bucket
}

`;
}

function buildEbs(data) {
    const name = tfName(data.name);
    const size = numValue(data.volumeSize, 10);
    const type = data.volumeType || 'gp3';

    return `${providerBlock(data)}resource "aws_ebs_volume" "${name}" {
  availability_zone = ${q(data.availabilityZone || 'us-east-1a')}
  size              = ${size}
  type              = ${q(type)}
  encrypted         = ${boolValue(data.encrypted, true)}

${commonTags(data)}
}

output "volume_id" {
  value = aws_ebs_volume.${name}.id
}

`;
}

function buildRds(data) {
    const name = tfName(data.name);
    const dbName = data.dbName || 'appdb';

    return `${providerBlock(data)}resource "aws_db_instance" "${name}" {
  identifier              = ${q(safeName(data.name))}
  engine                  = ${q(data.engine || 'mysql')}
  engine_version          = ${q(data.engineVersion || '8.0')}
  instance_class          = ${q(data.dbInstanceClass || 'db.t3.micro')}
  allocated_storage       = ${numValue(data.allocatedStorage, 20)}
  storage_encrypted       = true
  db_name                 = ${q(dbName)}
  username                = ${q(data.username || 'admin')}
  password                = ${q(data.password || 'ChangeMe12345!')}
  db_subnet_group_name    = ${q(data.dbSubnetGroup)}
  vpc_security_group_ids  = ${hclList(data.securityGroupIds)}
  backup_retention_period = ${numValue(data.backupRetentionDays, 7)}
  multi_az                = ${boolValue(data.multiAz, false)}
  skip_final_snapshot     = ${boolValue(data.skipFinalSnapshot, true)}
  deletion_protection     = ${boolValue(data.deletionProtection, false)}

${commonTags(data)}
}

output "db_endpoint" {
  value = aws_db_instance.${name}.endpoint
}

`;
}

function buildVpc(data) {
    const name = tfName(data.name);

    return `${providerBlock(data)}resource "aws_vpc" "${name}" {
  cidr_block           = ${q(data.vpcCidr || '10.0.0.0/16')}
  enable_dns_support   = ${boolValue(data.enableDnsSupport, true)}
  enable_dns_hostnames = ${boolValue(data.enableDnsHostnames, true)}

${commonTags(data)}
}

output "vpc_id" {
  value = aws_vpc.${name}.id
}

`;
}

function buildSecurityGroup(data) {
    const name = tfName(data.name);

    return `${providerBlock(data)}resource "aws_security_group" "${name}" {
  name        = ${q(data.name || 'terraform-sg')}
  description = ${q(data.description || 'Security group created by Terraform Agent')}
  vpc_id      = ${q(data.vpcId)}

  ingress {
    description = ${q(data.ruleDescription || 'Inbound rule')}
    from_port   = ${numValue(data.fromPort || data.port, 22)}
    to_port     = ${numValue(data.toPort || data.port, 22)}
    protocol    = ${q(data.protocol || 'tcp')}
    cidr_blocks = ${hclList(data.cidrBlocks || '0.0.0.0/0')}
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

${commonTags(data)}
}

output "security_group_id" {
  value = aws_security_group.${name}.id
}

`;
}

function buildAlb(data) {
    const name = tfName(data.name);

    return `${providerBlock(data)}resource "aws_lb" "${name}" {
  name               = ${q(safeName(data.name || 'terraform-alb'))}
  internal           = ${boolValue(data.internal, false)}
  load_balancer_type = "application"
  security_groups    = ${hclList(data.securityGroupIds)}
  subnets            = ${hclList(data.subnetIds)}

${commonTags(data)}
}

resource "aws_lb_target_group" "${name}" {
  name     = ${q(safeName((data.name || 'terraform-alb') + '-tg'))}
  port     = ${numValue(data.targetPort, 80)}
  protocol = ${q(data.targetProtocol || 'HTTP')}
  vpc_id   = ${q(data.vpcId)}
}

resource "aws_lb_listener" "${name}" {
  load_balancer_arn = aws_lb.${name}.arn
  port              = ${numValue(data.listenerPort, 80)}
  protocol          = ${q(data.listenerProtocol || 'HTTP')}

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.${name}.arn
  }
}

output "alb_dns_name" {
  value = aws_lb.${name}.dns_name
}

`;
}

function buildRoute53(data) {
    const name = tfName(data.recordName || data.name);

    return `${providerBlock(data)}resource "aws_route53_record" "${name}" {
  zone_id = ${q(data.hostedZoneId)}
  name    = ${q(data.recordName)}
  type    = ${q(data.recordType || 'A')}
  ttl     = ${numValue(data.ttl, 300)}
  records = ${hclList(data.records)}
}

output "record_fqdn" {
  value = aws_route53_record.${name}.fqdn
}

`;
}

function buildEcs(data) {
    const name = tfName(data.name);

    return `${providerBlock(data)}resource "aws_ecs_cluster" "${name}" {
  name = ${q(data.clusterName || data.name || 'terraform-ecs-cluster')}

${commonTags(data)}
}

output "ecs_cluster_id" {
  value = aws_ecs_cluster.${name}.id
}

`;
}

function buildEks(data) {
    const name = tfName(data.clusterName || data.name);

    return `${providerBlock(data)}resource "aws_eks_cluster" "${name}" {
  name     = ${q(data.clusterName || data.name || 'terraform-eks-cluster')}
  role_arn = ${q(data.clusterRoleArn)}
  version  = ${q(data.kubernetesVersion || '1.29')}

  vpc_config {
    subnet_ids         = ${hclList(data.subnetIds)}
    security_group_ids = ${hclList(data.securityGroupIds)}
  }

${commonTags(data)}
}

output "eks_cluster_endpoint" {
  value = aws_eks_cluster.${name}.endpoint
}

`;
}

function buildLambda(data) {
    const name = tfName(data.functionName || data.name);

    return `${providerBlock(data)}resource "aws_lambda_function" "${name}" {
  function_name = ${q(data.functionName || data.name || 'terraform-lambda')}
  role          = ${q(data.lambdaRoleArn)}
  runtime       = ${q(data.runtime || 'nodejs20.x')}
  handler       = ${q(data.handler || 'index.handler')}
  filename      = ${q(data.zipFile || 'function.zip')}
  memory_size   = ${numValue(data.memorySize, 128)}
  timeout       = ${numValue(data.timeout, 30)}

${commonTags(data)}
}

output "lambda_function_name" {
  value = aws_lambda_function.${name}.function_name
}

`;
}

function buildFsx(data) {
    const name = tfName(data.name);

    return `${providerBlock(data)}resource "aws_fsx_lustre_file_system" "${name}" {
  storage_capacity            = ${numValue(data.storageCapacity, 1200)}
  subnet_ids                  = ${hclList(data.subnetIds)}
  security_group_ids          = ${hclList(data.securityGroupIds)}
  deployment_type             = ${q(data.deploymentType || 'SCRATCH_2')}
  per_unit_storage_throughput = ${numValue(data.throughputCapacity, 125)}

${commonTags(data)}
}

output "fsx_dns_name" {
  value = aws_fsx_lustre_file_system.${name}.dns_name
}

`;
}

function buildElastiCache(data) {
    const name = tfName(data.name);

    return `${providerBlock(data)}resource "aws_elasticache_subnet_group" "${name}" {
  name       = ${q(safeName((data.name || 'cache') + '-subnet-group'))}
  subnet_ids = ${hclList(data.subnetIds)}
}

resource "aws_elasticache_cluster" "${name}" {
  cluster_id           = ${q(safeName(data.name || 'terraform-cache'))}
  engine               = ${q(data.engine || 'redis')}
  node_type            = ${q(data.nodeType || 'cache.t3.micro')}
  num_cache_nodes      = ${numValue(data.numCacheNodes, 1)}
  parameter_group_name = ${q(data.parameterGroupName || 'default.redis7')}
  port                 = ${numValue(data.port, 6379)}
  subnet_group_name    = aws_elasticache_subnet_group.${name}.name
  security_group_ids   = ${hclList(data.securityGroupIds)}

${commonTags(data)}
}

output "cache_cluster_address" {
  value = aws_elasticache_cluster.${name}.cache_nodes
}

`;
}

function buildTerraform(data) {
    const resourceType = String(data.resourceType || '').toLowerCase();

    if (resourceType === 'ec2') return buildEc2(data);
    if (resourceType === 's3') return buildS3(data);
    if (resourceType === 'ebs') return buildEbs(data);
    if (resourceType === 'rds') return buildRds(data);
    if (resourceType === 'vpc') return buildVpc(data);
    if (resourceType === 'security_group') return buildSecurityGroup(data);
    if (resourceType === 'alb') return buildAlb(data);
    if (resourceType === 'route53') return buildRoute53(data);
    if (resourceType === 'ecs') return buildEcs(data);
    if (resourceType === 'eks') return buildEks(data);
    if (resourceType === 'lambda') return buildLambda(data);
    if (resourceType === 'fsx') return buildFsx(data);
    if (resourceType === 'elasticache') return buildElastiCache(data);

    throw new Error(`Unsupported resource type: ${resourceType}`);
}

function writeStatus(reqDir, status, extra) {
    const body = Object.assign({
        status,
        updatedAt: new Date().toISOString()
    }, extra || {});

    fs.writeFileSync(
        path.join(reqDir, 'status.json'),
        JSON.stringify(body, null, 2)
    );
}

function runCommand(command, cwd) {
    return execSync(command, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 1000 * 60 * 15
    });
}

app.get('/', (req, res) => {
    res.json({
        status: 'OK',
        service: 'AWS Terraform Multi Resource Agent'
    });
});

app.post('/generate', (req, res) => {
    try {
        const data = req.body;
        const requestId = 'REQ-' + Date.now();
        const reqDir = path.join(BASE_DIR, requestId);

        fs.mkdirSync(reqDir, { recursive: true });

        const terraform = buildTerraform(data);

        fs.writeFileSync(
            path.join(reqDir, 'main.tf'),
            terraform
        );

        fs.writeFileSync(
            path.join(reqDir, 'request.json'),
            JSON.stringify(data, null, 2)
        );

        writeStatus(reqDir, 'GENERATED', {
            requestId,
            resourceType: data.resourceType,
            resourceName: data.name || data.bucketName || data.clusterName || data.functionName || 'resource'
        });

        res.json({
            success: true,
            requestId,
            status: 'GENERATED',
            terraform
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

app.get('/requests', (req, res) => {
    try {
        const items = fs.readdirSync(BASE_DIR)
            .filter(item => item.startsWith('REQ-'))
            .map(item => {
                const reqDir = path.join(BASE_DIR, item);
                const statusFile = path.join(reqDir, 'status.json');
                const requestFile = path.join(reqDir, 'request.json');

                let status = {};
                let request = {};

                if (fs.existsSync(statusFile)) {
                    status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
                }

                if (fs.existsSync(requestFile)) {
                    request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
                }

                return {
                    requestId: item,
                    resourceType: request.resourceType || status.resourceType || '',
                    resourceName: request.name || request.bucketName || request.clusterName || request.functionName || '',
                    status: status.status || 'UNKNOWN',
                    updatedAt: status.updatedAt || ''
                };
            })
            .sort((a, b) => b.requestId.localeCompare(a.requestId));

        res.json(items);
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

app.get('/request/:id', (req, res) => {
    try {
        const reqDir = path.join(BASE_DIR, req.params.id);
        const requestFile = path.join(reqDir, 'request.json');
        const statusFile = path.join(reqDir, 'status.json');

        if (!fs.existsSync(reqDir)) {
            return res.status(404).json({ error: 'Request not found' });
        }

        res.json({
            requestId: req.params.id,
            request: fs.existsSync(requestFile) ? JSON.parse(fs.readFileSync(requestFile, 'utf8')) : {},
            status: fs.existsSync(statusFile) ? JSON.parse(fs.readFileSync(statusFile, 'utf8')) : {}
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

app.get('/terraform/:id', (req, res) => {
    try {
        const tfFile = path.join(BASE_DIR, req.params.id, 'main.tf');

        if (!fs.existsSync(tfFile)) {
            return res.status(404).json({ error: 'Terraform file not found' });
        }

        res.type('text/plain').send(fs.readFileSync(tfFile, 'utf8'));
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

app.post('/plan/:id', (req, res) => {
    const reqDir = path.join(BASE_DIR, req.params.id);

    try {
        if (!fs.existsSync(reqDir)) {
            return res.status(404).json({ error: 'Request not found' });
        }

        writeStatus(reqDir, 'PLANNING', { requestId: req.params.id });

        const initOutput = runCommand('terraform init -input=false', reqDir);
        const planOutput = runCommand('terraform plan -input=false', reqDir);

        fs.writeFileSync(path.join(reqDir, 'plan.log'), initOutput + '\n' + planOutput);

        writeStatus(reqDir, 'PLANNED', { requestId: req.params.id });

        res.json({
            success: true,
            requestId: req.params.id,
            status: 'PLANNED',
            output: planOutput
        });
    } catch (err) {
        writeStatus(reqDir, 'PLAN_FAILED', {
            requestId: req.params.id,
            error: err.message
        });

        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

app.post('/apply/:id', (req, res) => {
    const reqDir = path.join(BASE_DIR, req.params.id);

    try {
        if (!fs.existsSync(reqDir)) {
            return res.status(404).json({ error: 'Request not found' });
        }

        writeStatus(reqDir, 'APPLYING', { requestId: req.params.id });

        const initOutput = runCommand('terraform init -input=false', reqDir);
        const applyOutput = runCommand('terraform apply -auto-approve -input=false', reqDir);

        fs.writeFileSync(path.join(reqDir, 'apply.log'), initOutput + '\n' + applyOutput);

        let outputJson = {};
        try {
            const rawOutput = runCommand('terraform output -json', reqDir);
            outputJson = JSON.parse(rawOutput || '{}');
            fs.writeFileSync(path.join(reqDir, 'outputs.json'), JSON.stringify(outputJson, null, 2));
        } catch (ignoreErr) {
            outputJson = {};
        }

        writeStatus(reqDir, 'CREATED', {
            requestId: req.params.id,
            outputs: outputJson
        });

        res.json({
            success: true,
            requestId: req.params.id,
            status: 'CREATED',
            output: applyOutput,
            terraformOutputs: outputJson
        });
    } catch (err) {
        writeStatus(reqDir, 'APPLY_FAILED', {
            requestId: req.params.id,
            error: err.message
        });

        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

app.post('/destroy/:id', (req, res) => {
    const reqDir = path.join(BASE_DIR, req.params.id);

    try {
        if (!fs.existsSync(reqDir)) {
            return res.status(404).json({ error: 'Request not found' });
        }

        writeStatus(reqDir, 'DESTROYING', { requestId: req.params.id });

        const destroyOutput = runCommand('terraform destroy -auto-approve -input=false', reqDir);

        fs.writeFileSync(path.join(reqDir, 'destroy.log'), destroyOutput);

        writeStatus(reqDir, 'DESTROYED', { requestId: req.params.id });

        res.json({
            success: true,
            requestId: req.params.id,
            status: 'DESTROYED',
            output: destroyOutput
        });
    } catch (err) {
        writeStatus(reqDir, 'DESTROY_FAILED', {
            requestId: req.params.id,
            error: err.message
        });

        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

app.listen(5000, () => {
    console.log('AWS Terraform Multi Resource Agent running on port 5000');
});
