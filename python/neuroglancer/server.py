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

import asyncio
import concurrent.futures
import socket
import sys
import argparse
import threading
import multiprocessing
import weakref
import numpy as np

import tornado.httpserver
import tornado.platform.asyncio
import tornado.netutil
import tornado.web

from http import server
from syconn.handler.logger import log_main as logger
from neuroglancer import static
from neuroglancer import config
from neuroglancer.config import initialize_server
from neuroglancer.random_token import make_random_token
from neuroglancer.cli import add_server_arguments
from neuroglancer.handlers import *

global_static_content_source = None

global_server_args = dict(host='localhost', port=0)

debug = False

_IS_GOOGLE_COLAB = 'google.colab' in sys.modules

def _get_server_url(bind_address: str, port: int) -> str:
    if _IS_GOOGLE_COLAB:
        return _get_colab_server_url(port)
    return _get_regular_server_url(bind_address, port)

def _get_regular_server_url(bind_address: str, port: int) -> str:
    if bind_address == '0.0.0.0' or bind_address == '::':
        hostname = socket.getfqdn()
    else:
        hostname = bind_address

    return f'http://{hostname}:{port}'
	
def _get_colab_server_url(port: int) -> str:
    import google.colab.output
    return google.colab.output.eval_js(f'google.colab.kernel.proxyPort({port})') 



class Server(object):
    def __init__(self, ioloop, host='127.0.0.1', port=0):
        self.viewers = {}
        self.viewers = weakref.WeakValueDictionary()
        # self.token = make_random_token()
        self.thread_executor = concurrent.futures.ThreadPoolExecutor(max_workers=multiprocessing.cpu_count(), thread_name_prefix='neuroglancer-thread-')

        self.ioloop = ioloop

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
                (ZEBRAFISH_SYN_COORD_REGEX, ZebraFishSyn2CoordHandler, dict(server=self)),
                (STATIC_PATH_REGEX, StaticPathHandler, dict(server=self)),
                (EVENTS_PATH_REGEX, EventStreamHandler, dict(server=self)),
                (SET_STATE_PATH_REGEX, SetStateHandler, dict(server=self)),
                (CREDENTIALS_PATH_REGEX, CredentialsHandler, dict(server=self)),
                # (INFO_PATH_REGEX, VolumeInfoHandler, dict(server=self)),
                # (SKELETON_INFO_PATH_REGEX, SkeletonInfoHandler, dict(server=self)),
                # (DATA_PATH_REGEX, SubvolumeHandler, dict(server=self)),
                # (SKELETON_PATH_REGEX, SkeletonHandler, dict(server=self)),
                # (MESH_PATH_REGEX, MeshHandler, dict(server=self)),
                (ACTION_PATH_REGEX, ActionHandler, dict(server=self)),
            ],
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
            self.server_url = f'http://{hostname}:{actual_port}'

        elif config.dev_environ_nginx:
            self.server_url = f'http://{hostname}:8080'

        else:
            self.server_url = 'https://syconn.esc.mpcdf.mpg.de'

        self._credentials_manager = None 

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
        if viewer_token not in self.server.viewers:
            logger.error("viewer not registered")
            self.send_error(404)
            return
        try:
            data, content_type = global_static_content_source.get(path)
        except ValueError as e:
            logger.error("Error sending files")
            self.send_error(404, message=e.args[0])
            return
        self.set_header('Content-type', content_type)
        self.finish(data)

class EventStreamStateWatcher:
    def __init__(self, key: str, client_id: str, state, last_generation: str, wake_up):
        self.key = key
        self.state = state
        self.last_generation = last_generation
        self._wake_up = wake_up
        self._client_id = client_id
        state.add_changed_callback(wake_up)

    def unregister(self):
        self.state.remove_changed_callback(self._wake_up)

    def maybe_send_update(self, handler):
        raw_state, generation = self.state.raw_state_and_generation
        if generation == self.last_generation: return False
        if generation.startswith(self._client_id + '/'): return False
        self.last_generation = generation
        msg = {'k': self.key, 's': raw_state, 'g': generation}
        handler.write(f'data: {encode_json(msg)}\n\n')
        return True

class EventStreamHandler(BaseRequestHandler):
    async def get(self, viewer_token: str):
        viewer = self.server.viewers.get(viewer_token)
        if viewer is None:
            self.send_error(404)
            return
        self.set_header('content-type', 'text/event-stream')
        self.set_header('cache-control', 'no-cache')
        must_flush = True
        wake_event = asyncio.Event()
        self._wake_up = lambda: self.server.ioloop.add_callback(wake_event.set)
        client_id = self.get_query_argument('c')
        self._closed = False

        watchers = []

        def watch(key: str, state):
            watchers.append(
                EventStreamStateWatcher(key=key,
                                        state=state,
                                        client_id=client_id,
                                        wake_up=self._wake_up,
                                        last_generation=self.get_query_argument(f'g{key}')))

        watch('c', viewer.config_state)
        if hasattr(viewer, 'shared_state'):
            watch('s', viewer.shared_state)

        try:
            while True:
                wake_event.clear()
                if self._closed: break
                try:
                    sent = False
                    for watcher in watchers:
                        sent = watcher.maybe_send_update(self) or sent
                    if sent:
                        self.flush()
                        if _IS_GOOGLE_COLAB:
                            # The proxy used by colab buffers the entire
                            # response.  Therefore we must end the response for
                            # the client to receive it.
                            break
                    elif must_flush:
                        self.flush()
                except tornado.iostream.StreamClosedError:
                    break
                await wake_event.wait()
                must_flush = False
        finally:
            for watcher in watchers:
                watcher.unregister()

    def on_connection_close(self):
        if debug:
            print('connection closed')
        super().on_connection_close()
        self._wake_up()
        self._closed = True

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
            asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

        done = threading.Event()
        logger.warning('Starting server')
        def start_server():
            # global global_server
            ioloop = tornado.platform.asyncio.AsyncIOLoop()
            ioloop.make_current()
            asyncio.set_event_loop(ioloop.asyncio_loop)
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
    logger.info(f"Viewer {viewer.token} is being attached")
    config.global_server.viewers[viewer.token] = viewer


def defer_callback(callback, *args, **kwargs):
    """Register `callback` to run in the server event loop thread."""
    config.global_server.ioloop.add_callback(lambda: callback(*args, **kwargs))

if __name__ == "__main__":
    
    ap = argparse.ArgumentParser()
    add_server_arguments(ap)
    args = ap.parse_args()
    set_server_bind_address(args.host, args.port)

    config.global_server_args = global_server_args

    if args.dev or args.dev_nginx:
        assert args.dev != args.dev_nginx, "--dev and --dev-nginx are mutually exclusive"

    config.dev_environ = args.dev
    config.dev_environ_nginx = args.dev_nginx

    if config.dev_environ_nginx:
        config.global_server_args['port'] = 8005
    elif config.dev_environ:
        assert config.global_server_args['port'] != None, "--port must be specified when using --dev"
    else:
        config.global_server_args['port'] = 5000

    initialize_server(dev=args.dev or args.dev_nginx)
    start()

    logger.info(f"Neuroglancer server running at {get_server_url()}")
