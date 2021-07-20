global global_server
global_server = None

global global_server_args
global_server_args = None

global dev_environ
dev_environ = False

global backend
backend = None

global seg_dataset
seg_dataset = None

global raw_dataset
raw_dataset = None

info = {
    "@type": "neuroglancer_multiscale_volume",
    "type": "image",
    "data_type": "uint8",
    "num_channels": 1,
    "scales": [
        {
            "key": "1_1_1",
            "size": [27136, 27392, 15616],
            "resolution": [10, 10, 25],
            "chunk_sizes": [[64, 64, 64]],
            "encoding": "raw",
        },
        {
            "key": "2_2_2",
            "size": [13568, 13696, 7808],
            "resolution": [20, 20, 50],
            "chunk_sizes": [[64, 64, 64]],
            "encoding": "raw",
        },
        {
            "key": "4_4_4",
            "size": [6784, 6912, 3968],
            "resolution": [40, 40, 100],
            "chunk_sizes": [[64, 64, 64]],
            "encoding": "raw",
        },
        {
            "key": "8_8_8",
            "size": [3389, 3418, 1936],
            "resolution": [80, 80, 200],
            "chunk_sizes": [[64, 64, 64]],
            "encoding": "raw",
        },
        {
            "key": "16_16_16",
            "size": [1694, 1709, 968],
            "resolution": [160, 160, 400],
            "chunk_sizes": [[64, 64, 64]],
            "encoding": "raw",
        },
        {
            "key": "32_32_32",
            "size": [847, 854, 484],
            "resolution": [320, 320, 800],
            "chunk_sizes": [[64, 64, 64]],
            "encoding": "raw",
        },
        {
            "key": "64_64_64",
            "size": [423, 427, 242],
            "resolution": [640, 640, 1600],
            "chunk_sizes": [[64, 64, 64]],
            "encoding": "raw",
        }
    ]
}