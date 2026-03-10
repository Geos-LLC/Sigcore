# ============================================================
# Sigcore — Terraform Variables
# ============================================================

variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "sigcore"
}

variable "environment" {
  description = "Environment (dev, staging, prod)"
  type        = string
  default     = "prod"
}

# --- Networking ---

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.1.0.0/16"
}

variable "availability_zones" {
  description = "List of AZs to use"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]
}

# --- ECS ---

variable "backend_cpu" {
  description = "Fargate task CPU units (512 = 0.5 vCPU)"
  type        = number
  default     = 512
}

variable "backend_memory" {
  description = "Fargate task memory in MB"
  type        = number
  default     = 1024
}

variable "desired_count" {
  description = "Number of ECS task instances"
  type        = number
  default     = 1
}

variable "container_port" {
  description = "Port the Sigcore container listens on"
  type        = number
  default     = 3002
}

# --- App ---

variable "callio_backend_url" {
  description = "LeadBridge (Callio) backend URL for CORS and callbacks"
  type        = string
  default     = "https://sigcore-production.up.railway.app"
}

# --- Database (external Supabase) ---

variable "database_url" {
  description = "Supabase session-mode PostgreSQL connection string (port 5432)"
  type        = string
  sensitive   = true
}

# --- Encryption ---

variable "encryption_key" {
  description = "32-byte hex encryption key for sensitive data"
  type        = string
  sensitive   = true
}

# --- Service Auth ---

variable "sigcore_service_key" {
  description = "Shared secret for Callio ↔ Sigcore internal service-to-service calls"
  type        = string
  sensitive   = true
}

# --- Twilio ---

variable "twilio_api_key" {
  description = "Twilio API key SID"
  type        = string
  sensitive   = true
  default     = ""
}

variable "twilio_api_secret" {
  description = "Twilio API key secret"
  type        = string
  sensitive   = true
  default     = ""
}

variable "twilio_twiml_app_sid" {
  description = "Twilio TwiML App SID for browser-based calling"
  type        = string
  default     = ""
}

# --- Loghub (Grafana log forwarding) ---

variable "loghub_url" {
  description = "Loghub ingest service URL"
  type        = string
  default     = "https://geosloghub-production.up.railway.app"
}

variable "loghub_source" {
  description = "Loghub source identifier for this app"
  type        = string
  default     = "sigcore"
}

variable "loghub_key" {
  description = "Loghub API key for the sigcore source"
  type        = string
  sensitive   = true
  default     = ""
}
