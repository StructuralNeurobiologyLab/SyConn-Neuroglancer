import asyncio
from datetime import time
import multiprocessing
import threading
import tornado.web
import tornado.ioloop
import tornado.iostream
import tornado.concurrent
from tornado import locks
import os
import time
import json
import numpy as np
import compressed_segmentation as cseg
import gzip
import concurrent.futures
import time

try:
    # Newer versions of tornado do not have the asynchronous decorator
    from sockjs.tornado.util import asynchronous
except ImportError:
    from tornado.web import asynchronous
# from tornado.web import asynchronous

from syconn import global_params
from syconn.analysis.property_filter import PropertyFilter
from syconn.analysis.utils import get_encoded_mesh, get_encoded_skeleton, get_mesh_meta, load_segmentation
from syconn.handler.logger import log_main as logger

import neuroglancer
from neuroglancer import local_volume, skeleton
from neuroglancer.config import params, tokenLock
from neuroglancer import config
from neuroglancer.random_token import make_random_token
from neuroglancer.chunks import encode_raw
from neuroglancer.json_utils import json_encoder_default


INFO_PATH_REGEX = r'^/neuroglancer/info/(?P<token>[^/]+)$'

SKELETON_INFO_PATH_REGEX = r'^/neuroglancer/skeletoninfo/(?P<token>[^/]+)$'

MESH_INFO_PATH_REGEX = r'^/neuroglancer/meshinfo/(?P<token>[^/]+)$'

DATA_PATH_REGEX = r'^/neuroglancer/(?P<data_format>[^/]+)/(?P<token>[^/]+)/(?P<scale_key>[^/]+)/(?P<start>[0-9]+(?:,[0-9]+)*)/(?P<end>[0-9]+(?:,[0-9]+)*)$'

SKELETON_PATH_REGEX = r'^/neuroglancer/skeleton/(?P<key>[^/]+)/(?P<object_id>[0-9]+)$'

MESH_PATH_REGEX = r'^/neuroglancer/mesh/(?P<key>[^/]+)/(?P<object_id>[0-9]+)$'

STATIC_PATH_REGEX = r'^/v/(?P<viewer_token>[^/]+)/(?P<path>(?:[a-zA-Z0-9_\-][a-zA-Z0-9_\-.]*)?)$'

ACTION_PATH_REGEX = r'^/action/(?P<viewer_token>[^/]+)$'

PRECOMPUTED_SKELETON_INFO_REGEX = r'^/skeletons/info$'

PRECOMPUTED_SKELETON_REGEX = r'^/skeletons/(?P<ssv_id>[0-9]+)$'

PRECOMPUTED_MESH_INFO_REGEX = r'^/(?P<obj_type>[a-z]{2})/info$'

PRECOMPUTED_MESH_META_REGEX = r'^/(?P<obj_type>[a-z]{2})/(?P<ssv_id>[0-9]+):(?P<lod>[0-9])$'

PRECOMPUTED_MESH_REGEX = r'^/(?P<obj_type>[a-z]{2})/(?P<ssv_id>[0-9]+):(?P<lod>[0-9]):\2_mesh$'

PRECOMPUTED_VOLUME_INFO_REGEX = r'^/volume/(?P<volume_type>[a-zA-Z]+)/info$'

PRECOMPUTED_VOLUME_REGEX = r'^/volume/(?P<volume_type>[a-zA-Z]+)/(?P<scale_key>[^/]+)/(?P<chunk>[^/]+)$'

PRECOMPUTED_SEG_PROPS_INFO_REGEX = r'^/properties/info$'

class BaseRequestHandler(tornado.web.RequestHandler):
    def initialize(self, server):
        # self.set_secure_cookie("session_id", session_key, samesite="None")
        self.server = server


class MainHandler(tornado.web.RequestHandler):
    def get(self):
        self.render("index.html")

class NotFoundHandler(tornado.web.RequestHandler):
    def prepare(self):  # for all methods
        raise tornado.web.HTTPError(
            status_code=404,
            reason="Invalid resource path. Test!"
        )

class TutorialsHandler(tornado.web.RequestHandler):
    def get(self):
        self.render("tutorials.html")


class AboutHandler(tornado.web.RequestHandler):
    def get(self):
        self.render("about.html")

# native coroutine
class TokenHandler(BaseRequestHandler):
    def post(self):
        logger.info("TokenHandler invoked")
        from neuroglancer.config import params
        
        try:
            params.acquisition = self.get_argument("acq_name")
            params.version = self.get_argument("data_version")
            print(params.acquisition)
            print(params.version)
        
        except tornado.web.MissingArgumentError as e:
            logger.error(e.args[0])
            self.send_error(404)
            return

        token = make_random_token()
        pf = PropertyFilter(params, ['mi', 'vc', 'sj'], token)
        logger.debug(f"Viewer instances in memory: {len(config.global_server.viewers.keys())}")

        try:
            self.redirect(pf.viewer.get_viewer_url())
        except Exception as e:
            self.send_error(404, message=e.args[0])
            return
        
        # try:
        #     if config.dev_environ:
        #         host = config.global_server_args['host']
        #         port = config.global_server_args['port']
        #         self.redirect(f"http://{host}:{port}/v/{token}/")
                    
        #     else:
        #         self.redirect(f"http://syconn.esc.mpcdf.mpg.de/v/{token}/")

        # except Exception as e:
        #     logger.warning(f"Viewer not available")
        #     logger.error(e)
        #     self.send_error(404)
        #     return

class SharedURLHandler(BaseRequestHandler):
    def get(self):
        print(self.request.uri)
        self.render("about.html")
        
            
class PrecomputedSkeletonInfoHandler(BaseRequestHandler):
    def get(self):
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
                
            self.set_header('Content-type', 'application/json')
            self.finish(json.dumps(info))

        except Exception as e:
            logger.error('Error retrieving skeletons info. {}'.format(e.args[0]))
            self.send_error(404)
            return


class PrecomputedSkeletonHandler(BaseRequestHandler):
    @asynchronous
    def get(self, ssv_id):
        from neuroglancer.config import params 
        def handle_result(f):
            try:
                encoded_skeleton = f.result()

            except Exception as e:
                self.send_error(500, message=e.args[0])
                return

            # self.server.thread_executor.shutdown()

            if encoded_skeleton == -1:
                logger.error('Skeleton not available for ssv_id: {}'.format(ssv_id)) 
                self.send_error(404) 
                return

            self.set_header('Content-type', 'application/octet-stream')
            self.set_header('Content-encoding', 'gzip')
            self.finish(gzip.compress(encoded_skeleton, compresslevel=6))

        future = self.server.thread_executor.submit(
            get_encoded_skeleton, params["backend"], ssv_id, params["segmentation"].scale
        )

        tornado.concurrent.future_add_done_callback(
            future, 
            lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
        )
        

class PrecomputedMeshInfoHandler(BaseRequestHandler):
    def get(self, obj_type):
        try:    
            self.set_header('Content-type', 'application/json')
            self.finish(json.dumps({"@type": "neuroglancer_legacy_mesh"}))

        except Exception as e:
            logger.error('Error retrieving {} mesh info. {}'.format(obj_type, e.args[0]))
            self.send_error(404)
            return

class PrecomputedMeshMetaHandler(BaseRequestHandler):
    @asynchronous
    def get(self, obj_type, ssv_id, lod):
        def handle_result(f):
            try:
                meta = f.result() 

            except Exception as e:
                self.send_error(500, message=e.args[0])
                return

            self.set_header('Content-type', 'application/json')
            # self.set_header('Content-encoding', 'gzip')
            self.finish(meta)

        future = self.server.thread_executor.submit(
            get_mesh_meta, ssv_id, lod
        )
        
        tornado.concurrent.future_add_done_callback(
            future,
            lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
        )
        
class PrecomputedMeshHandler(BaseRequestHandler):
    @asynchronous
    def get(self, obj_type, ssv_id, lod):
        from neuroglancer.config import params
        def handle_result(f):
            try:
                encoded_mesh = f.result()

            except Exception as e:
                self.send_error(500, message=e.args[0])
                return

            if encoded_mesh == -1:
                logger.error('{} mesh not available for ssv_id: {}'.format(obj_type, ssv_id))
                self.send_error(404)
                return

            self.set_header('Content-type', 'application/octet-stream')
            self.set_header('Content-encoding', 'gzip')
            self.finish(gzip.compress(encoded_mesh, compresslevel=6))

        future = self.server.thread_executor.submit(
            get_encoded_mesh, params["backend"], ssv_id, obj_type
        )
        
        tornado.concurrent.future_add_done_callback(
            future,
            lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
        )

class PrecomputedVolumeInfoHandler(BaseRequestHandler):
    def get(self, volume_type):
        from neuroglancer.config import params
        try:
            info = config.volume_info
            info["type"] = volume_type

            if volume_type == "segmentation":
                info["data_type"] = "uint64"
                for level in range(len(params["segmentation"].available_mags)):
                    info["scales"][level]["encoding"] = "compressed_segmentation"
                    info["scales"][level]["compressed_segmentation_block_size"] = [8, 8, 8]

            elif volume_type == "image":
                info["data_type"] = "uint8"
                for level in range(len(params["image"].available_mags)):
                    info["scales"][level]["encoding"] = "raw"

            self.set_header('Content-type', 'application/json')
            self.set_header('Content-encoding', 'gzip')
            info = bytes(json.dumps(info), 'utf-8')
            self.finish(gzip.compress(info, compresslevel=6))

        except Exception as e:
            logger.error('Error retrieving {} info. {}'.format(volume_type, e.args[0]))
            self.send_error(404)
            return

class PrecomputedVolumeHandler(BaseRequestHandler):
    @asynchronous
    def get(self, volume_type, scale_key, chunk):
        from neuroglancer.config import params
        mag = np.array(scale_key.split('_'), dtype=np.int32)[0]
        x, y, z = chunk.split('_')
        xBegin, xEnd = map(int, x.split('-'))
        yBegin, yEnd = map(int, y.split('-'))
        zBegin, zEnd = map(int, z.split('-'))

        begin_offset = tuple(np.s_[xBegin * mag, yBegin * mag, zBegin * mag] )
        end_offset = tuple(np.s_[xEnd * mag, yEnd * mag, zEnd * mag])

        size = tuple(np.subtract(end_offset, begin_offset))
        # print(begin_offset, size, scale_key)

        kwargs = dict(offset=begin_offset, size=size, mag=mag)

        def handle_result(f):
            try:
                data = f.result()

            except Exception as e:
                logger.error(e.args[0])
                self.send_error(500, message=e.args[0])
                return

            self.set_header('Content-type', 'application/octet-stream')
            self.set_header('Content-encoding', 'gzip')

            if volume_type == "segmentation":
                compressed_data = cseg.compress(data, block_size=(8,8,8), order='F')
                # self.finish(compressed_data)
                self.finish(gzip.compress(compressed_data, compresslevel=6))
            else:
                self.finish(gzip.compress(encode_raw(data), compresslevel=6))

        if volume_type == "segmentation":
            kwargs.update({'cube_type': 'segmentation', 'path': params['segmentation_path']})
            future = self.server.thread_executor.submit(
                load_segmentation, **kwargs
            )

        elif volume_type == "image":
            future = self.server.thread_executor.submit(
                params["image"].load_raw, **kwargs
            )
            
        tornado.concurrent.future_add_done_callback(
            future,
            lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
        )

def read_file(filename):
    with open(os.path.join("/home/hashir", filename), "rb") as f:
        data = f.read()

    return data

class PrecomputedSegPropsInfoHandler(BaseRequestHandler):
    @asynchronous
    def get(self):
        from neuroglancer.config import params
        def handle_result(f):
            try:
                data = f.result()

            except Exception as e:
                logger.error(e.args[0])
                self.send_error(500, message=e.args[0])
                return

            self.set_header('Content-type', 'application/json')
            self.set_header('Content-encoding', 'gzip')
            self.finish(gzip.compress(data, compresslevel=6))

        filename = params.acquisition + "_" + params.version + ".json"
        future = self.server.thread_executor.submit(read_file, filename)

        tornado.concurrent.future_add_done_callback(
            future,
            lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
        )


class ActionHandler(BaseRequestHandler):
    def post(self, viewer_token):
        viewer = self.server.viewers.get(viewer_token)
        if viewer is None:
            self.send_error(404)
            return
        action = json.loads(self.request.body)
        self.server.ioloop.add_callback(viewer.actions.invoke, action['action'], action['state'])
        self.finish('')


class VolumeInfoHandler(BaseRequestHandler):
    def get(self, token):
        vol = self.server.get_volume(token)
        if vol is None or not isinstance(vol, local_volume.LocalVolume):
            self.send_error(404)
            return
        self.finish(json.dumps(vol.info(), default=json_encoder_default).encode())


class SkeletonInfoHandler(BaseRequestHandler):
    def get(self, token):
        vol = self.server.get_volume(token)
        if vol is None or not isinstance(vol, skeleton.SkeletonSource):
            self.send_error(404)
            return
        self.finish(json.dumps(vol.info(), default=json_encoder_default).encode())


# class SubvolumeHandler(BaseRequestHandler):
#     @asynchronous
#     def get(self, data_format, token, scale_key, start, end):
#         start_pos = np.array(start.split(','), dtype=np.int64)
#         end_pos = np.array(end.split(','), dtype=np.int64)
#         vol = self.server.get_volume(token)
#         if vol is None or not isinstance(vol, local_volume.LocalVolume):
#             self.send_error(404)
#             return

#         def handle_subvolume_result(f):
#             try:
#                 data, content_type = f.result()
#             except ValueError as e:
#                 self.send_error(400, message=e.args[0])
#                 return

#             self.set_header('Content-type', content_type)
#             self.finish(data)

#         self.server.thread_executor.submit(
#             vol.get_encoded_subvolume,
#             data_format=data_format, start=start_pos, end=end_pos,
#             scale_key=scale_key).add_done_callback(
#             lambda f: self.server.ioloop.add_callback(lambda: handle_subvolume_result(f)))


# class MeshHandler(BaseRequestHandler):
#     @asynchronous
#     def get(self, key, object_id):
#         object_id = int(object_id)
#         vol = self.server.get_volume(key)
#         if vol is None or not isinstance(vol, (local_volume.LocalVolume)):
#             self.send_error(404)
#             return

#         def handle_mesh_result(f):
#             try:
#                 encoded_mesh = f.result()
#             except local_volume.MeshImplementationNotAvailable:
#                 self.send_error(501, message='Mesh implementation not available')
#                 return
#             except local_volume.MeshesNotSupportedForVolume:
#                 self.send_error(405, message='Meshes not supported for volume')
#                 return
#             except local_volume.InvalidObjectIdForMesh:
#                 self.send_error(404, message='Mesh not available for specified object id')
#                 return
#             except ValueError as e:
#                 self.send_error(400, message=e.args[0])
#                 return

#             self.set_header('Content-type', 'application/octet-stream')
#             self.finish(encoded_mesh)

#         # mesh as a subsource of local volume
#         if vol.precomputed_mesh is True:
#             logger.info('Loading precomputed mesh')
#             self.server.thread_executor.submit(vol.get_object_mesh_precomputed, 
#                     object_id).add_done_callback(
#                             lambda f: self.server.ioloop.add_callback(lambda: handle_mesh_result(f)))
#         """
#         else:
#             print('Loading generated mesh')
#             self.server.executor.submit(vol.get_object_mesh, vol, 
#                     object_id).add_done_callback(
#                             lambda f: self.server.ioloop.add_callback(lambda: handle_mesh_result(f)))
#         """

# class SkeletonHandler(BaseRequestHandler):
#     @asynchronous
#     def get(self, key, object_id):
#         object_id = int(object_id)
#         vol = self.server.get_volume(key)
#         if vol is None or not isinstance(vol, skeleton.SkeletonSource):
#             self.send_error(404)

#         def handle_result(f):
#             try:
#                 encoded_skeleton = f.result()
#             except Exception as e:
#                 self.send_error(500, message=e.args[0])
#                 return
#             if encoded_skeleton is None:
#                 self.send_error(404, message='Skeleton not available for specified object id')
#                 return
#             self.set_header('Content-type', 'application/octet-stream')
#             self.finish(encoded_skeleton)

#         def get_encoded_skeleton(skeletons, object_id):
#             skeleton = skeletons.get_skeleton(object_id)
#             if skeleton is None:
#                 return None
#             return skeleton.encode(skeletons)

#         self.server.thread_executor.submit(
#             get_encoded_skeleton, vol, object_id).add_done_callback(
#             lambda f: self.server.ioloop.add_callback(lambda: handle_result(f)))