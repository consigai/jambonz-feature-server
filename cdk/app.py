#!/usr/bin/env python3
import os
from aws_cdk import (
    aws_ecr as ecr,
    aws_ecr_assets as ecr_assets,
    Stack,
)
import cdk_ecr_deployment as ecrdeploy
import aws_cdk as cdk
from constructs import Construct

class EcrRepositoryStack(cdk.Stack):
    def __init__(self, scope: Construct, id: str, **kwargs) -> None:
        super().__init__(scope, id, **kwargs)

        # Create the ECR repository
        repository = ecr.Repository(self,
                       "ConsigjambonzFeatureServerRepo",
                       repository_name="consig-jambonz-feature-server")

        jambonzFeatureServer_image_asset = ecr_assets.DockerImageAsset(self, "jambonzFeatureServer",
                                directory="../",  # Path to the directory with Dockerfile
                                platform=ecr_assets.Platform.LINUX_AMD64,
                                build_args={
                                    "BUILD_CPUS": "4",
                                    "TARGETARCH": "x86_64",
                                },
                            )
        # Get the GitHub commit hash from the environment variable
        github_sha = os.getenv('GITHUB_SHA', 'local')
        github_branch = os.getenv('GITHUB_REF_NAME', 'local')

        # Deploy the Docker image to the ECR repository with both the commit hash and branch name as tags
        ecrdeploy.ECRDeployment(self, "DeployDockerImageSHA",
                      src=ecrdeploy.DockerImageName(jambonzFeatureServer_image_asset.image_uri),
                      dest=ecrdeploy.DockerImageName(f"{repository.repository_uri}:{github_sha}"))

        ecrdeploy.ECRDeployment(self, "DeployDockerImageBranch",
                      src=ecrdeploy.DockerImageName(jambonzFeatureServer_image_asset.image_uri),
                      dest=ecrdeploy.DockerImageName(f"{repository.repository_uri}:{github_branch}"))

app = cdk.App()

#
# Create Docker Repo
#
EcrRepositoryStack(app, "jambonzFeatureServer")

app.synth()
