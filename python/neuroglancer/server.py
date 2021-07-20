# @license
# Copyright 2017 Google Inc.
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from __future__ import absolute_import, print_function

import concurrent.futures
import json
import multiprocessing
import os
import socket
import sys
import threading
import weakref
import argparse

import numpy as np
from numpy.core.fromnumeric import size
import tornado.httpserver
import tornado.ioloop
import tornado.netutil
import tornado.web
import tornado.wsgi
import tornado.template

import sockjs.tornado

import compressed_segmentation as cseg

try:
    # Newer versions of tornado do not have the asynchronous decorator
    from sockjs.tornado.util import asynchronous
except ImportError:
    from tornado.web import asynchronous

from neuroglancer import local_volume, static, skeleton
from neuroglancer import config
from neuroglancer.json_utils import json_encoder_default
from neuroglancer.random_token import make_random_token
from neuroglancer.sockjs_handler import SOCKET_PATH_REGEX, SOCKET_PATH_REGEX_WITHOUT_GROUP, SockJSHandler
from neuroglancer.flask_server import app
from neuroglancer.chunks import encode_raw, encode_jpeg, encode_npz
# from neuroglancer.quart_server import app
from neuroglancer.cli import add_server_arguments
from syconn.handler.logger import log_main as logger
from syconn import global_params
from syconn.analysis.backend import SyConnBackend
from syconn.analysis.utils import get_encoded_mesh, get_encoded_skeleton, get_mesh_meta
from knossos_utils import KnossosDataset

INFO_PATH_REGEX = r'^/neuroglancer/info/(?P<token>[^/]+)$'

SKELETON_INFO_PATH_REGEX = r'^/neuroglancer/skeletoninfo/(?P<token>[^/]+)$'

MESH_INFO_PATH_REGEX = r'^/neuroglancer/meshinfo/(?P<token>[^/]+)$'

DATA_PATH_REGEX = r'^/neuroglancer/(?P<data_format>[^/]+)/(?P<token>[^/]+)/(?P<scale_key>[^/]+)/(?P<start>[0-9]+(?:,[0-9]+)*)/(?P<end>[0-9]+(?:,[0-9]+)*)$'

SKELETON_PATH_REGEX = r'^/neuroglancer/skeleton/(?P<key>[^/]+)/(?P<object_id>[0-9]+)$'

MESH_PATH_REGEX = r'^/neuroglancer/mesh/(?P<key>[^/]+)/(?P<object_id>[0-9]+)$'

STATIC_PATH_REGEX = r'^/v/(?P<viewer_token>[^/]+)/(?P<path>(?:[a-zA-Z0-9_\-][a-zA-Z0-9_\-.]*)?)$'

ACTION_PATH_REGEX = r'^/action/(?P<viewer_token>[^/]+)$'

PRECOMPUTED_INFO_REGEX = r'^/(?P<obj_type>[a-zA-Z]+)/info$'

PRECOMPUTED_SKELETON_REGEX = r'^/skeletons/(?P<ssv_id>[0-9]+)$'

PRECOMPUTED_MESH_META_REGEX = r'^/(?P<obj_type>[a-zA-Z]+)/(?P<ssv_id>[0-9]+):(?P<lod>[0-9])$'

PRECOMPUTED_MESH_REGEX = r'^/(?P<obj_type>[a-zA-Z]+)/(?P<ssv_id>[0-9]+):(?P<lod>[0-9]):\2_mesh$'

PRECOMPUTED_VOLUME_INFO_REGEX = r'^/volume/(?P<volume_type>[a-zA-Z]+)/info$'

PRECOMPUTED_VOLUME_REGEX = r'^/volume/(?P<volume_type>[a-zA-Z]+)/(?P<scale_key>[^/]+)/(?P<chunk>[^/]+)$'

# PRECOMPUTED_IMG_VOLUME_REGEX = r'^/volume/img/(?P<scale_key>[^/]+)/(?P<chunk>[^/]+)$'

global_static_content_source = None

global_server_args = dict(host='localhost', port=0)

debug = False

if config.backend == None:
    config.backend =  SyConnBackend(global_params.config.working_dir, logger, synthresh=0.9)

if config.seg_dataset == None:
    config.seg_dataset = KnossosDataset(os.path.expanduser(global_params.config.kd_seg_path))

scale = config.seg_dataset.scale

if config.raw_dataset == None:
    config.raw_dataset = KnossosDataset('/wholebrain/songbird/j0251/j0251_72_clahe2')

class Server(object):
    def __init__(self, ioloop, host='127.0.0.1', port=0):
        self.viewers = weakref.WeakValueDictionary()
        self.token = make_random_token()
        self.executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=multiprocessing.cpu_count())

        self.ioloop = ioloop
        sockjs_router = sockjs.tornado.SockJSRouter(
            SockJSHandler, SOCKET_PATH_REGEX_WITHOUT_GROUP, io_loop=ioloop)
        sockjs_router.neuroglancer_server = self

        settings = {
            "template_path": os.path.join(os.path.dirname(__file__), "templates"),
            "static_path": os.path.join(os.path.dirname(__file__), "static")
        }

        def log_function(handler):
            if debug:
                print("%d %s %.2fs" % (handler.get_status(),
                                       handler.request.uri, handler.request.request_time()))

        flask_app = tornado.wsgi.WSGIContainer(app)
        tornado_app = self.app = tornado.web.Application(
            [
                (PRECOMPUTED_INFO_REGEX, PrecomputedInfoHandler, dict(server=self)),
                (PRECOMPUTED_SKELETON_REGEX, PrecomputedSkeletonHandler, dict(server=self)),
                # (PRECOMPUTED_MESH_META_REGEX, PrecomputedMeshMetaHandler, dict(server=self)),
                # (PRECOMPUTED_MESH_REGEX, PrecomputedMeshHandler, dict(server=self)),
                (PRECOMPUTED_VOLUME_INFO_REGEX, PrecomputedVolumeInfoHandler, dict(server=self)),
                (PRECOMPUTED_VOLUME_REGEX, PrecomputedVolumeHandler, dict(server=self)),
                (STATIC_PATH_REGEX, StaticPathHandler, dict(server=self)),
                (INFO_PATH_REGEX, VolumeInfoHandler, dict(server=self)),
                (SKELETON_INFO_PATH_REGEX, SkeletonInfoHandler, dict(server=self)),
                (DATA_PATH_REGEX, SubvolumeHandler, dict(server=self)),
                (SKELETON_PATH_REGEX, SkeletonHandler, dict(server=self)),
                (MESH_PATH_REGEX, MeshHandler, dict(server=self)),
                (ACTION_PATH_REGEX, ActionHandler, dict(server=self)),
            ] + sockjs_router.urls + [(r"/(.*)", tornado.web.FallbackHandler, dict(fallback=flask_app))],
            log_function=log_function,
            # Set a large maximum message size to accommodate large screenshot
            # messages.
            websocket_max_message_size=100 * 1024 * 1024,
            **settings)
        http_server = tornado.httpserver.HTTPServer(
            tornado_app,
            # Allow very large requests to accommodate large screenshots.
            max_buffer_size=1024 ** 3,
            xheaders=True
        )
        sockets = tornado.netutil.bind_sockets(port=port, address=host)
        http_server.add_sockets(sockets)
        actual_port = sockets[0].getsockname()[1]

        global global_static_content_source
        if global_static_content_source is None:
            global_static_content_source = static.get_default_static_content_source()

        if host == '0.0.0.0' or host == '::':
            hostname = socket.getfqdn()
        else:
            hostname = host

        self.server_url = 'http://%s:%s' % (hostname, actual_port)

    def get_volume(self, key):
        dot_index = key.find('.')
        if dot_index == -1:
            return None
        viewer_token = key[:dot_index]
        volume_token = key[dot_index + 1:]
        viewer = self.viewers.get(viewer_token)
        if viewer is None:
            return None
        return viewer.volume_manager.volumes.get(volume_token)


class BaseRequestHandler(tornado.web.RequestHandler):
    def initialize(self, server):
        self.server = server

"""
class MainHandler(BaseRequestHandler):
    def get(self):
        self.render("index.html")

class TokenHandler(BaseRequestHandler):
    def post(self):
        token = make_random_token()
        seg_path = global_params.config.kd_seg_path
        PropertyFilter(backend, seg_path, ['mi', 'vc', 'sj'], clargs={}, token=token)

        if config.dev_environ:
            host = config.global_server_args['host']
            port = config.global_server_args['port']
            print('Development')
            self.redirect(f"http://{host}:{port}/v/{token}/")
        
        else:
            print('Production')
            self.set_header('Allow', 'POST')
            self.redirect(f"http://syconn.esc.mpcdf.mpg.de/v/{token}/")
"""

class PrecomputedInfoHandler(BaseRequestHandler):
    def get(self, obj_type):
        try:
            if obj_type == "skeletons":
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

            else:
                info = {
                    "@type": "neuroglancer_legacy_mesh"
                }

            self.set_header('Content-type', 'application/json')
            self.finish(json.dumps(info))

        except Exception as e:
            print('Error retrieving info {} for {}'.format(e.args[0], obj_type))
            self.send_error(404)
            return

class PrecomputedSkeletonHandler(BaseRequestHandler):
    @asynchronous
    def get(self, ssv_id): 
        def handle_result(f):
            try:
                encoded_skeleton = f.result()

            except Exception as e:
                self.send_error(500, message=e.args[0])
                return

            if encoded_skeleton == -1:
                logger.error('Skeleton not available for ssv_id: {}'.format(ssv_id))
                self.send_error(404) 
                return

            self.set_header('Content-type', 'application/octet-stream')
            self.set_header('Content-encoding', 'precomputed')
            self.finish(encoded_skeleton)

        self.server.executor.submit(
            get_encoded_skeleton, config.backend, ssv_id, scale
        ).add_done_callback(
            lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
        )

class PrecomputedMeshMetaHandler(BaseRequestHandler):
    @asynchronous
    def get(self, obj_type, ssv_id, lod):
        def handle_meta_result(f):
            meta = f.result()

            self.set_header('Content-type', 'application/json')
            self.finish(meta)

        self.server.executor.submit(
            get_mesh_meta, ssv_id, lod
        ).add_done_callback(
            lambda f: self.server.ioloop.add_callback(lambda: handle_meta_result(f))
        )
        
class PrecomputedMeshHandler(BaseRequestHandler):
    @asynchronous
    def get(self, obj_type, ssv_id, lod):
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
            self.set_header('Content-encoding', 'precomputed')
            self.finish(encoded_mesh)

        self.server.executor.submit(
            get_encoded_mesh, config.backend, ssv_id, obj_type
        ).add_done_callback(
            lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
        )

class PrecomputedVolumeInfoHandler(BaseRequestHandler):
    @asynchronous
    def get(self, volume_type):
        try:
            if volume_type == "seg":
                config.info["type"] = "segmentation"
                config.info["data_type"] = "uint64"
                config.info["num_channels"] = 1
                for level in range(len(config.seg_dataset.available_mags)):
                    config.info["scales"][level]["encoding"] = "raw"

                info = config.info

            elif volume_type == "img":
                config.info["type"] = "image"
                config.info["data_type"] = "uint8"
                config.info["num_channels"] = 1
                for level in range(len(config.raw_dataset.available_mags)):
                    config.info["scales"][level]["encoding"] = "raw"

                info = config.info

            self.set_header('Content-type', 'application/json')
            self.finish(json.dumps(info))

        except Exception as e:
            print('Error retrieving info {} for {}'.format(e.args[0], volume_type))
            self.send_error(404)
            return

class PrecomputedVolumeHandler(BaseRequestHandler):
    @asynchronous
    def get(self, volume_type, scale_key, chunk):
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
                print('Error happened')
                self.send_error(500, message=e.args[0])
                return

            self.set_header('Content-type', 'application/octet-stream')
            self.set_header('Content-encoding', 'precomputed')
            if volume_type == "seg" and config.info["scales"][0]["encoding"] == "compressed_segmentation":
                self.finish(cseg.compress(data, order='F'))
            
            self.finish(encode_raw(data))

        if volume_type == "seg":
            self.server.executor.submit(
                config.seg_dataset.load_seg, **kwargs
            ).add_done_callback(
                lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
            )

        elif volume_type == "img":
            self.server.executor.submit(
                config.raw_dataset.load_raw, **kwargs
            ).add_done_callback(
                lambda f: self.server.ioloop.add_callback(lambda: handle_result(f))
            )

class StaticPathHandler(BaseRequestHandler):
    def get(self, viewer_token, path):
        if viewer_token != self.server.token and viewer_token not in self.server.viewers:
            self.send_error(404)
            return
        try:
            data, content_type = global_static_content_source.get(path)
        except ValueError as e:
            self.send_error(404, message=e.args[0])
            return
        self.set_header('Content-type', content_type)
        self.finish(data)


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


class SubvolumeHandler(BaseRequestHandler):
    @asynchronous
    def get(self, data_format, token, scale_key, start, end):
        start_pos = np.array(start.split(','), dtype=np.int64)
        end_pos = np.array(end.split(','), dtype=np.int64)
        vol = self.server.get_volume(token)
        if vol is None or not isinstance(vol, local_volume.LocalVolume):
            self.send_error(404)
            return

        def handle_subvolume_result(f):
            try:
                data, content_type = f.result()
            except ValueError as e:
                self.send_error(400, message=e.args[0])
                return

            self.set_header('Content-type', content_type)
            self.finish(data)

        self.server.executor.submit(
            vol.get_encoded_subvolume,
            data_format=data_format, start=start_pos, end=end_pos,
            scale_key=scale_key).add_done_callback(
            lambda f: self.server.ioloop.add_callback(lambda: handle_subvolume_result(f)))


class MeshHandler(BaseRequestHandler):
    @asynchronous
    def get(self, key, object_id):
        object_id = int(object_id)
        vol = self.server.get_volume(key)
        if vol is None or not isinstance(vol, (local_volume.LocalVolume)):
            self.send_error(404)
            return

        def handle_mesh_result(f):
            try:
                encoded_mesh = f.result()
            except local_volume.MeshImplementationNotAvailable:
                self.send_error(501, message='Mesh implementation not available')
                return
            except local_volume.MeshesNotSupportedForVolume:
                self.send_error(405, message='Meshes not supported for volume')
                return
            except local_volume.InvalidObjectIdForMesh:
                self.send_error(404, message='Mesh not available for specified object id')
                return
            except ValueError as e:
                self.send_error(400, message=e.args[0])
                return

            self.set_header('Content-type', 'application/octet-stream')
            self.finish(encoded_mesh)

        # mesh as a subsource of local volume
        if vol.precomputed_mesh is True:
            logger.info('Loading precomputed mesh')
            self.server.executor.submit(vol.get_object_mesh_precomputed, 
                    object_id).add_done_callback(
                            lambda f: self.server.ioloop.add_callback(lambda: handle_mesh_result(f)))
        """
        else:
            print('Loading generated mesh')
            self.server.executor.submit(vol.get_object_mesh, vol, 
                    object_id).add_done_callback(
                            lambda f: self.server.ioloop.add_callback(lambda: handle_mesh_result(f)))
        """

class SkeletonHandler(BaseRequestHandler):
    @asynchronous
    def get(self, key, object_id):
        object_id = int(object_id)
        vol = self.server.get_volume(key)
        if vol is None or not isinstance(vol, skeleton.SkeletonSource):
            self.send_error(404)

        def handle_result(f):
            try:
                encoded_skeleton = f.result()
            except:
                self.send_error(500, message=e.args[0])
                return
            if encoded_skeleton is None:
                self.send_error(404, message='Skeleton not available for specified object id')
                return
            self.set_header('Content-type', 'application/octet-stream')
            self.finish(encoded_skeleton)

        def get_encoded_skeleton(skeletons, object_id):
            skeleton = skeletons.get_skeleton(object_id)
            if skeleton is None:
                return None
            return skeleton.encode(skeletons)

        self.server.executor.submit(
            get_encoded_skeleton, vol, object_id).add_done_callback(
            lambda f: self.server.ioloop.add_callback(lambda: handle_result(f)))

global_server = None


def set_static_content_source(*args, **kwargs):
    global global_static_content_source
    global_static_content_source = static.get_static_content_source(*args, **kwargs)


def set_server_bind_address(bind_address='127.0.0.1', bind_port=0):
    global global_server_args
    global_server_args = dict(host=bind_address, port=bind_port)


def is_server_running():
    return global_server is not None


def stop():
    """Stop the server, invalidating any viewer URLs.

    This allows any previously-referenced data arrays to be garbage collected if there are no other
    references to them.
    """
    global global_server
    if global_server is not None:
        ioloop = global_server.ioloop

        def stop_ioloop():
            ioloop.stop()

        global_server.ioloop.add_callback(stop_ioloop)
        global_server = None


def get_server_url():
    return config.global_server.server_url


_global_server_lock = threading.Lock()

def start():
    # global global_server
    with _global_server_lock:
        if config.global_server is not None: return

        # Workaround https://bugs.python.org/issue37373
        # https://www.tornadoweb.org/en/stable/index.html#installation
        if sys.platform == 'win32' and sys.version_info >= (3, 8):
            import asyncio
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

        done = threading.Event()

        def start_server():
            global global_server
            ioloop = tornado.ioloop.IOLoop()
            ioloop.make_current()
            config.global_server = Server(ioloop=ioloop, **global_server_args)
            done.set()
            ioloop.start()
            ioloop.close()

        thread = threading.Thread(target=start_server)
        thread.daemon = True
        thread.start()
        done.wait()


def register_viewer(viewer):
    # start()
    # global_server.viewers[viewer.token] = viewer
    config.global_server.viewers[viewer.token] = viewer


def defer_callback(callback, *args, **kwargs):
    """Register `callback` to run in the server event loop thread."""
    start()
    config.global_server.ioloop.add_callback(lambda: callback(*args, **kwargs))

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    add_server_arguments(ap)
    args = ap.parse_args()
    set_server_bind_address(args.host, args.port)

    config.global_server_args = global_server_args
    config.dev_environ = args.dev
    
    start()
    
    if args.dev:
        logger.info("[DEV] Neuroglancer server running at {}".format(get_server_url()))
    else:
        logger.info("[PROD] Neuroglancer server running at http://syconn.esc.mpcdf.mpg.de")
