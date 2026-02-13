variable "project_name" {
  type    = string
  default = "mixchat"
}

variable "aws_region" {
  type    = string
  default = "ap-northeast-2"
}

#aws 프로필 구분
#variable "aws_profile" {
#  type    = string
#  default = "dev"
#}

variable "allowed_ssh_cidr" {
  type        = string
  description = "e.g. 1.2.3.4/32"
}

variable "ec2_instance_type" {
  type    = string
  default = "t3.small"
}

variable "ec2_volume_gb" {
  type    = number
  default = 30
}

variable "ec2_key_name" {
  type    = string
  default = "mixchat-ec2-key"
}

variable "ec2_public_key_path" {
  type        = string
  description = "e.g. ~/.ssh/mixchat_ec2.pub"
}

# RDS (MySQL 기준)
variable "db_engine" {
  type    = string
  default = "mysql"
}

variable "db_engine_version" {
  type    = string
  default = "8.0"
}

variable "db_instance_class" {
  type    = string
  default = "db.t3.micro"
}

variable "db_allocated_storage" {
  type    = number
  default = 20
}

variable "db_name" {
  type    = string
  default = "mixchat"
}

variable "db_username" {
  type = string
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "tags" {
  type = map(string)
  default = {
    managed-by = "terraform"
  }
}