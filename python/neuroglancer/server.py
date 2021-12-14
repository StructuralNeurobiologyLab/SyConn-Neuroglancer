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
import socket
import sys
import argparse
import threading
import multiprocessing

import tornado.httpserver
import tornado.ioloop
import tornado.netutil
import tornado.web
import tornado.template
import sockjs.tornado

from syconn.handler.logger import log_main as logger

from neuroglancer import static
from neuroglancer import config
from neuroglancer.config import initialize_server
from neuroglancer.random_token import make_random_token
from neuroglancer.sockjs_handler import SOCKET_PATH_REGEX, SOCKET_PATH_REGEX_WITHOUT_GROUP, SockJSHandler
from neuroglancer.cli import add_server_arguments
from neuroglancer.handlers import *

global_static_content_source = None

global_server_args = dict(host='localhost', port=0)

debug = False


class Server(object):
    def __init__(self, ioloop, host='127.0.0.1', port=0):
        # self.viewers = weakref.WeakValueDictionary()
        self.viewers = {}
        # self.token = make_random_token()
        self.thread_executor = concurrent.futures.ThreadPoolExecutor(max_workers=multiprocessing.cpu_count()*5, thread_name_prefix='neuroglancer-thread-')
        # self.proc_executor = concurrent.futures.ProcessPoolExecutor(max_workers=multiprocessing.cpu_count())

        self.ioloop = ioloop
        sockjs_router = sockjs.tornado.SockJSRouter(
            SockJSHandler, SOCKET_PATH_REGEX_WITHOUT_GROUP, io_loop=ioloop)
        sockjs_router.neuroglancer_server = self

        settings = {
            "template_path": os.path.join(os.path.dirname(__file__), "templates"),
            "static_path": os.path.join(os.path.dirname(__file__), "static"),
            "serve_traceback": True # default error page will include the traceback of the error
        }

        def log_function(handler):
            if debug:
                print("%d %s %.2fs" % (handler.get_status(),
                                       handler.request.uri, handler.request.request_time()))

        tornado_app = self.app = tornado.web.Application(
            [
                (SHARED_URL_REGEX, SharedURLHandler, dict(server=self)),
                (r'/', MainHandler),
                (r'^/_generate_token', TokenHandler, dict(server=self)),
                (r'^/index.html', MainHandler),
                (r'^/tutorials.html', TutorialsHandler),
                (r'^/about.html', AboutHandler),
                # (SHARED_URL_REGEX, SharedURLHandler, dict(server=self)),
                (PRECOMPUTED_SKELETON_INFO_REGEX, PrecomputedSkeletonInfoHandler, dict(server=self)), 
                (PRECOMPUTED_SKELETON_REGEX, PrecomputedSkeletonHandler, dict(server=self)),
                (PRECOMPUTED_MESH_INFO_REGEX, PrecomputedMeshInfoHandler, dict(server=self)),
                (PRECOMPUTED_MESH_META_REGEX, PrecomputedMeshMetaHandler, dict(server=self)),
                (PRECOMPUTED_MESH_REGEX, PrecomputedMeshHandler, dict(server=self)),
                (PRECOMPUTED_VOLUME_INFO_REGEX, PrecomputedVolumeInfoHandler, dict(server=self)),
                (PRECOMPUTED_VOLUME_REGEX, PrecomputedVolumeHandler, dict(server=self)),
                (PRECOMPUTED_SEG_PROPS_INFO_REGEX, PrecomputedSegPropsInfoHandler, dict(server=self)),
                (STATIC_PATH_REGEX, StaticPathHandler, dict(server=self)),
                # (INFO_PATH_REGEX, VolumeInfoHandler, dict(server=self)),
                # (SKELETON_INFO_PATH_REGEX, SkeletonInfoHandler, dict(server=self)),
                # (DATA_PATH_REGEX, SubvolumeHandler, dict(server=self)),
                # (SKELETON_PATH_REGEX, SkeletonHandler, dict(server=self)),
                # (MESH_PATH_REGEX, MeshHandler, dict(server=self)),
                (ACTION_PATH_REGEX, ActionHandler, dict(server=self)),
            ] + sockjs_router.urls,
            # + [(r"/(.*)", tornado.web.FallbackHandler, dict(fallback=flask_app))],
            default_handler_class=NotFoundHandler,
            log_function=log_function,
            # Set a large maximum message size to accommodate large screenshot
            # messages.
            websocket_max_message_size=500 * 1024 * 1024,
            **settings)

        http_server = tornado.httpserver.HTTPServer(
            tornado_app,
            # Allow very large requests to accommodate large screenshots.
            max_buffer_size=1024 ** 3,
            # https://www.tornadoweb.org/en/stable/guide/running.html#running-behind-a-load-balancer
            xheaders=True # Allow X-headers when running behind a reverse proxy
        )
        sockets = tornado.netutil.bind_sockets(port=port, address=host)
        # tornado.process.fork_processes(0)
        http_server.add_sockets(sockets)
        actual_port = sockets[0].getsockname()[1]

        global global_static_content_source
        if global_static_content_source is None:
            global_static_content_source = static.get_default_static_content_source()

        if host == '0.0.0.0' or host == '::':
            hostname = socket.getfqdn()
        else:
            hostname = host

        if config.dev_environ:
            # self.server_url = 'http://%s:%s' % (hostname, actual_port)
            self.server_url = 'http://localhost:9005'
        else:
            self.server_url = 'https://syconn.esc.mpcdf.mpg.de'

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

class StaticPathHandler(BaseRequestHandler):
    def get(self, viewer_token, path):
        # logger.info("StaticPathHandler invoked")
        # if viewer_token != self.server.token and viewer_token not in self.server.viewers:
        if viewer_token not in self.server.viewers:
            logger.error("viewer not registered")
            self.send_error(404)
            return
        try:
            data, content_type = global_static_content_source.get(path)
            # logger.warning(f"Data sent by StaticPathHandler {content_type}")
        except ValueError as e:
            logger.error("Error sending files")
            self.send_error(404, message=e.args[0])
            return
        self.set_header('Content-type', content_type)
        self.finish(data)


def set_static_content_source(*args, **kwargs):
    global global_static_content_source
    global_static_content_source = static.get_static_content_source(*args, **kwargs)


def set_server_bind_address(bind_address='127.0.0.1', bind_port=0):
    global global_server_args
    global_server_args = dict(host=bind_address, port=bind_port)


def is_server_running():
    return config.global_server is not None


def stop():
    """Stop the server, invalidating any viewer URLs.

    This allows any previously-referenced data arrays to be garbage collected if there are no other
    references to them.
    """
    # global global_server
    if config.global_server is not None:
        ioloop = config.global_server.ioloop

        def stop_ioloop():
            ioloop.stop()

        config.global_server.ioloop.add_callback(stop_ioloop)
        config.global_server = None


def get_server_url():
    return config.global_server.server_url


_global_server_lock = threading.Lock()

def start():
    with _global_server_lock:
        if config.global_server is not None: return

        # Workaround https://bugs.python.org/issue37373
        # https://www.tornadoweb.org/en/stable/index.html#installation
        if sys.platform == 'win32' and sys.version_info >= (3, 8):
            import asyncio
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

        done = threading.Event()
        logger.warning('Starting server')
        def start_server():
            # global global_server
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

# _register_viewer_lock = threading.Lock()

def register_viewer(viewer):
    # start()
    # global_server.viewers[viewer.token] = viewer
    # with _register_viewer_lock:
    logger.info(f"Viewer {viewer.token} is being attached")
    config.global_server.viewers[viewer.token] = viewer


def defer_callback(callback, *args, **kwargs):
    """Register `callback` to run in the server event loop thread."""
    # start()
    config.global_server.ioloop.add_callback(lambda: callback(*args, **kwargs))

if __name__ == "__main__":
    
    ap = argparse.ArgumentParser()
    add_server_arguments(ap)
    args = ap.parse_args()
    set_server_bind_address(args.host, args.port)

    initialize_server()

    config.global_server_args = global_server_args
    config.dev_environ = args.dev

    start()

    logger.info(f"Neuroglancer server running at {get_server_url()}")

    # if args.dev:
    #     logger.info("[DEV] Neuroglancer server running at {}".format(get_server_url()))
    # else:
    #     logger.info(f"[PROD] Neuroglancer server running at http://syconn.esc.mpcdf.mpg.de ({args.host}:{args.port})")
