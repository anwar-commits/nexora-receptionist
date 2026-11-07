-- Local only. Creates the login the API uses. It is a member of app_api
-- (created by migration 0002), so it is always subject to row-level security.
-- In production these logins are created by Terraform with secrets from AWS Secrets Manager.
CREATE ROLE dr_api LOGIN PASSWORD 'dr_api_local';
