#!/usr/bin/env bash
helper() {
  echo "helping"
}

run() {
  helper
  grep "x" file.txt
}

run
