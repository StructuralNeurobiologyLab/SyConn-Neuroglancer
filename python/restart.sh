#!/bin/bash

cd /media/neuro/syconn-neuroglancer/python/neuroglancer

until python -i server.py; do
    echo "Server crashed with exit code $?. Respawning.." >&2
    sleep 1
done

