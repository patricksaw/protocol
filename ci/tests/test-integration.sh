#!/bin/bash

cat << EOF
  test-integration:
    machine:
      image: ubuntu-2004:202010-01
    working_directory: ~/protocol
    steps:
      - restore_cache:
          key: protocol-completed-build-{{ .Environment.CIRCLE_SHA1 }}
      - run:
          name: Install dependencies
          command: |
            sudo apt update
            sudo apt install nodejs npm
            sudo npm install -g n
            sudo n 15.10.0
            PATH="$PATH"
            sudo npm install --global yarn
      - run:
          name: Run integration tests
          command: |
            node -v
            npm -v
            yarn -v
            yarn optimism-up
            sleep 60
            yarn --cwd packages/core test-e2e
EOF
