data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default_vpc_subnets" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# Ubuntu 22.04 LTS AMI (서울 리전)
data "aws_ami" "ubuntu_2204" {
  most_recent = true
  owners      = ["099720109477"] # Canonical

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_key_pair" "ec2_key" {
  key_name   = var.ec2_key_name
  public_key = file(pathexpand(var.ec2_public_key_path))

  tags = merge(var.tags, {
    Name = "${var.project_name}-ec2-key"
  })
}

# EC2 보안그룹: 80/443 전체, 22 내 IP만
resource "aws_security_group" "ec2_sg" {
  name        = "${var.project_name}-ec2-sg"
  description = "ec2 sg"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "http"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "https"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "ssh from my ip"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_ssh_cidr]
  }

  egress {
    description = "all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, {
    Name = "${var.project_name}-ec2-sg"
  })
}

resource "aws_iam_role" "ec2_role" {
  name = "${var.project_name}-ec2-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [{
      Effect = "Allow",
      Principal = { Service = "ec2.amazonaws.com" },
      Action = "sts:AssumeRole"
    }]
  })

  tags = merge(var.tags, {
    Name = "${var.project_name}-ec2-role"
  })
}

# SSM 접속용(추천)
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.ec2_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# ECR Pull 용(이미지 기반 배포에 필수)
resource "aws_iam_role_policy_attachment" "ecr_read" {
  role       = aws_iam_role.ec2_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# (선택) CloudWatch Agent 권한(모니터링/로그)
resource "aws_iam_role_policy_attachment" "cw_agent" {
  role       = aws_iam_role.ec2_role.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_instance_profile" "ec2_profile" {
  name = "${var.project_name}-ec2-profile"
  role = aws_iam_role.ec2_role.name

  tags = merge(var.tags, {
    Name = "${var.project_name}-ec2-profile"
  })
}

resource "aws_instance" "app" {
  ami                    = data.aws_ami.ubuntu_2204.id
  instance_type          = var.ec2_instance_type
  subnet_id              = data.aws_subnets.default_vpc_subnets.ids[0]
  vpc_security_group_ids = [aws_security_group.ec2_sg.id]
  key_name               = aws_key_pair.ec2_key.key_name

  iam_instance_profile = aws_iam_instance_profile.ec2_profile.name

  root_block_device {
    volume_size = var.ec2_volume_gb
    volume_type = "gp3"
  }

  tags = merge(var.tags, {
    Name = "${var.project_name}-ec2"
  })
}

# 고정 IP
resource "aws_eip" "app_eip" {
  domain = "vpc"
  tags = merge(var.tags, {
    Name = "${var.project_name}-eip"
  })
}

resource "aws_eip_association" "app_eip_assoc" {
  instance_id   = aws_instance.app.id
  allocation_id = aws_eip.app_eip.id
}

# RDS 서브넷 그룹 (기본 VPC 서브넷들 사용)
resource "aws_db_subnet_group" "rds_subnet_group" {
  name       = "${var.project_name}-rds-subnet-group"
  subnet_ids = data.aws_subnets.default_vpc_subnets.ids

  tags = merge(var.tags, {
    Name = "${var.project_name}-rds-subnet-group"
  })
}

# RDS 보안그룹: DB 포트는 EC2 SG에서만 허용
resource "aws_security_group" "rds_sg" {
  name        = "${var.project_name}-rds-sg"
  description = "rds sg"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "db from ec2 sg"
    from_port       = 3306
    to_port         = 3306
    protocol        = "tcp"
    security_groups = [aws_security_group.ec2_sg.id]
  }

  egress {
    description = "all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, {
    Name = "${var.project_name}-rds-sg"
  })
}

resource "aws_db_instance" "rds" {
  identifier = "${var.project_name}-rds"

  engine         = var.db_engine
  engine_version = var.db_engine_version

  instance_class    = var.db_instance_class
  allocated_storage = var.db_allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true
  #storage_type      = "gp2"

  db_name  = var.db_name
  username = var.db_username
  password = var.db_password

  db_subnet_group_name   = aws_db_subnet_group.rds_subnet_group.name
  vpc_security_group_ids = [aws_security_group.rds_sg.id]

  publicly_accessible = false
  multi_az            = false

  # 프리티어 활용 위해 0일, 운영 시 7일
  backup_retention_period = 0

  # 운영 시 final snapshot + deletion protection 적용 예정
  skip_final_snapshot = true

  tags = merge(var.tags, {
    Name = "${var.project_name}-rds"
  })
}

# 나중에 ALB를 쓰거나, 리버스 프록시 구조로 바꾸면 EC2는 ALB에서만 받게 바꾸는 게 정석
# subnet_id = data.aws_subnets.default_vpc_subnets.ids[0] 랜덤 위험(AZ 필터링 또는 public subnet만 고르도록)
# 보안그룹에서 80/443를 EC2에 직접 오픈, 나중에 ALB 사용하거나 리버스 프록시 구조로 바꾸면 ALB에서만 받도록
# RDS Subnet Group이 “default vpc 서브넷 전체” 사용하는 게 문제될 수도