#!/bin/bash
dnf install -y docker mariadb105
systemctl enable --now docker
usermod -aG docker ec2-user
