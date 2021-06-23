from flask import Flask, abort, make_response
from flask_cors import CORS
from syconn.analysis.backend import SyConnBackend
from syconn.analysis.utils import get_encoded_mesh, get_encoded_skeleton
from syconn.handler.logger import log_main as logger
from knossos_utils import KnossosDataset
from syconn import global_params
import json
import os

backend = SyConnBackend(global_params.config.working_dir, logger, synthresh=0.9)
seg_dataset = KnossosDataset(os.path.expanduser(global_params.config.kd_seg_path))
scale = seg_dataset.scale

ATTRIBUTES = ('sv', 'mi', 'sj', 'vc')

app = Flask(__name__)
cors = CORS(app, resources={r"/*": {"origins": "http://localhost:5000"}})
app.config['CORS_HEADERS'] = ['Content-Type', 'Authorization']
# app.config['SEND_FILE_MAX_AGE_DEFAULT'] = 0

@app.route("/")
def get():
        return json.dumps("Welcome to Flask!")

@app.route("/skeletons/info", methods=['GET'])
def get_skeleton_info():
    try:
        info = {
            "@type": "neuroglancer_skeletons",
            "transform": [  # identity (no) transformation
                1, 
                0, 
                0, 
                0,
                0, 
                1, 
                0, 
                0,
                0, 
                0, 
                1, 
                0
            ],
            "vertex_attributes": [],
            "spatial_index": None
        }
        response = make_response(json.dumps(info))
        response.cache_control.max_age=300
        response.content_type = 'application/json'

        return response
    
    except:
        print('Error retrieving skeleton info')
        abort(404)

@app.route("/skeletons/<int:ssv_id>", methods=['GET'])
def get_skeleton(ssv_id):
    """Download encoded skeleton"""
    try:
        encoded_skeleton = get_encoded_skeleton(backend, ssv_id, scale)
        
        if encoded_skeleton == -1:
            logger.error('Skeleton not available for ssv_id: {}'.format(ssv_id))
            abort(404) 

        response = make_response(encoded_skeleton)
        response.cache_control.max_age = 0
        response.content_type = 'application/octet-stream'
        response.content_encoding = 'precomputed'

        return response

    except:
        logger.error('Error retrieving encoded skeleton of ssv_id {}'.format(ssv_id))
        abort(404)

@app.route("/<string:obj_type>/info", methods=['GET'])
def get_info(obj_type):
    """Download info."""
    try:
        response = make_response(json.dumps({"@type": "neuroglancer_legacy_mesh"}))
        response.cache_control.max_age = 0
        response.content_type = 'application/json'
    
        return response

    except:
        logger.error('Error retrieving {} info'.format(obj_type))
        abort(404)

@app.route("/<string:obj_type>/<int:ssv_id>:<int:lod>", methods=['GET'])
def get_metadata(obj_type, ssv_id, lod):
    """Download metadata"""
    try:
        fragments = []
        fragments.append('{}:{}:{}_mesh'.format(ssv_id, lod, ssv_id))
        response = make_response(json.dumps({"fragments": fragments}))
        response.cache_control.max_age = 0
        response.content_type = 'application/json'
        
        return response

    except:
        logger.error('Error retrieving json metadata of ssv_id {}'.format(ssv_id))
        abort(404)

@app.route("/<string:obj_type>/<int:ssv_id_1>:<int:lod>:<int:ssv_id_2>_mesh", methods=['GET'])
def get_seg(obj_type, ssv_id_1, lod, ssv_id_2):
    """Download encoded mesh"""
    try:
        if obj_type not in ATTRIBUTES:
            logger.error('Invalid obj_type argument. Found {}, should be one of {}'.format(obj_type, ATTRIBUTES))
            abort(404)

        encoded_mesh = get_encoded_mesh(backend, ssv_id_1, obj_type)

        if encoded_mesh == -1:
            logger.error('{} mesh not available for ssv_id: {}'.format(obj_type, ssv_id_1))
            abort(404)

        response = make_response(encoded_mesh)
        response.cache_control.max_age = 0
        response.content_type = 'application/octet-stream'
        response.content_encoding = 'precomputed'

        return response

    except:
        logger.error('Error retrieving encoded mesh of ssv_id {}'.format(ssv_id_1))
        abort(404)

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8000)
