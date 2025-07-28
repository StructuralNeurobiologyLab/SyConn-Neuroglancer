import os
import numpy as np
import pickle

from syconn.reps.super_segmentation import SuperSegmentationDataset
from syconn.reps.segmentation import SegmentationDataset
from syconn import global_params
from syconn.handler.logger import log_main as logger
from knossos_utils import KnossosDataset


global dev_environ, dev_environ_nginx

class NeuroConfig(object):
    """Stores datasets, backends and npy arrays in memory when the
    server is launched. Created once per server execution
    
    TODO:
        * Check if there is a better way to do this
    """
    
    _counter = 0

    def __init__(self):
        NeuroConfig._counter += 1
        self._id = NeuroConfig._counter

        self.entries = {
            "j0251": {
                "rag_flat_Jan2019_v2": {
                    "working_dir": None,
                    "ssd": None,
                    "segmentation": None,
                    "segmentation_path": None,
                    "image": None,
                    "boundary": None,
                    "scale": None,
                    "ssvs": None,
                    "celltypes": None,
                    "mis": None,
                    "sizes": None,
                    "neuron_partners": None,
                    "partner_axoness": None,
                    "partner_celltypes": None,
                    "syn_probs": None,
                    "syn_areas": None,
                    "rep_coords": None,
                    "tpl_mask": None,
                    "info": None,
                },
                "rag_flat_Jan2019_v3": {
                    "working_dir": None,
                    "ssd": None,
                    "segmentation": None,
                    "segmentation_path": None,
                    "image": None,
                    "boundary": None,
                    "scale": None,
                    "ssvs": None,
                    "celltypes": None,
                    "mis": None,
                    "sizes": None,
                    "neuron_partners": None,
                    "partner_axoness": None,
                    "partner_celltypes": None,
                    "syn_probs": None,
                    "syn_areas": None,
                    "rep_coords": None,
                    "tpl_mask": None,
                    "info": None,
                },
                "72_seg_20210127_agglo2": {
                    "working_dir": None,
                    "ssd": None,
                    "segmentation": None,
                    "segmentation_path": None,
                    "image": None,
                    "boundary": None,
                    "scale": None,
                    "ssvs": None,
                    "celltypes": None,
                    "mis": None,
                    "sizes": None,
                    "neuron_partners": None,
                    "partner_axoness": None,
                    "partner_celltypes": None,
                    "syn_probs": None,
                    "syn_areas": None,
                    "rep_coords": None,
                    "tpl_mask": None,
                    "info": None,
                },
                "72_seg_20210127_agglo2_syn_20220811_celltypes_20230822": {
                    "working_dir": None,
                    "ssd": None,
                    "segmentation": None,
                    "segmentation_path": None,
                    "image": None,
                    "boundary": None,
                    "scale": None,
                    "ssvs": None,
                    "celltypes": None,
                    "mis": None,
                    "sizes": None,
                    "neuron_partners": None,
                    "partner_axoness": None,
                    "partner_celltypes": None,
                    "syn_probs": None,
                    "syn_areas": None,
                    "rep_coords": None,
                    "tpl_mask": None,
                    "info": None,    
                }
            },
            "j0126": {
                "areaxfs_v10": {
                    "working_dir": None,
                    "ssd": None,
                    "segmentation": None,
                    "segmentation_path": None,
                    "image": None,
                    "boundary": None,
                    "scale": None,
                    "ssvs": None,
                    "celltypes": None,
                    "mis": None,
                    "sizes": None,
                    "neuron_partners": None,
                    "partner_axoness": None,
                    "partner_celltypes": None,
                    "syn_probs": None,
                    "syn_areas": None,
                    "rep_coords": None,
                    "tpl_mask": None,
                    "info": None,
                },
                "assembled_core_relabeled": {
                    "working_dir": None,
                    "ssd": None,
                    "segmentation": None,
                    "segmentation_path": None,
                    "image": None,
                    "boundary": None,
                    "scale": None,
                    "ssvs": None,
                    "celltypes": None,
                    "mis": None,
                    "sizes": None,
                    "neuron_partners": None,
                    "partner_axoness": None,
                    "partner_celltypes": None,
                    "syn_probs": None,
                    "syn_areas": None,
                    "rep_coords": None,
                    "tpl_mask": None,
                    "info": None,
                }
            },
            "zf": {
                "fw363": {
                    "working_dir": None,
                    "ssd": None,
                    "segmentation": None,
                    "segmentation_path": None,
                    "image": None,
                    "boundary": None,
                    "scale": None,
                    "ssvs": None,
                    "celltypes": None,
                    "mis": None,
                    "sizes": None,
                    "neuron_partners": None,
                    "partner_axoness": None,
                    "partner_celltypes": None,
                    "syn_probs": None,
                    "syn_areas": None,
                    "rep_coords": None,
                    "tpl_mask": None,
                    "info": None,
                },
            }
        }

    def __getitem__(self, key):
        return self.entries[self.acquisition][self.version][key]

    def __setitem__(self, key, value):
        self.entries[self.acquisition][self.version][key] = value

    @property
    def id(self):
        return self._id

    @property
    def acquisition(self):
        return self._acquisition

    @acquisition.setter
    def acquisition(self, value):
        self._acquisition = value

    @property
    def version(self):
        return self._version

    @version.setter
    def version(self, value):
        self._version = value


def generate_info(kd: KnossosDataset) -> dict:
    """Generate Neuroglancer precomputed volume info for a Knossos
    dataset

    Args:
        kd (KnossosDataset): 

    Returns:
        dict: volume info
    """    
    info = {}
    info["@type"] = "neuroglancer_multiscale_volume"
    info["type"] = None
    info["data_type"] = None
    info["num_channels"] = 1
    info["scales"] = [
        {
            "key": f"{int(i)}_{int(i)}_{int(i)}",
            "size": ([int(b) // int(i) for b in kd.boundary]),
            "resolution": [int(s) * int(i) for s in kd.scale],
            "chunk_sizes": [[64, 64, 64]],
            "encoding": "raw",
        } for i in sorted([16, 8, 32, 2, 4, 64, 1])
    ]

    return info


def load_dataset(wd: str, global_params, logger):
    """Loads the segmentation datasets and properties from the
    working directory into memory.

    Args:
        wd (str): working directory
        global_params (): global parameters of syconn
        logger (): syconn logger
    """
    if not os.path.exists(wd):
        logger.error(f'Working directory {wd} does not exist. Skipping.')
        return

    global_params.wd = wd
    
    ssd = SuperSegmentationDataset(global_params.config.working_dir)
    sd = SegmentationDataset(obj_type='syn_ssv', working_dir=global_params.config.working_dir)
    

    params["working_dir"] = global_params.config.working_dir
    params["ssd"] = ssd
    if "celltypes_20230822" in wd:  # load er SegmentationDataset (only available for j0251_72_seg_20210127_agglo2_syn_20220811_celltypes_20230822)
        sd_er = SegmentationDataset(obj_type='er', working_dir=global_params.config.working_dir)
        params["sd_er"] = sd_er

    # load zebra fish segmentation and image from the web
    if params.acquisition == 'zf':  
        # params["segmentation"] = KnossosDataset(global_params.config.kd_seg_path)
        # params["segmentation_path"] = global_params.config.kd_seg_path
        # params["image"] = KnossosDataset(os.path.join(global_params.config.kd_seg_path))
        # params["boundary"] = [int(b) for b in params["segmentation"].boundary]
        # params["scale"] = [int(s) for s in params["segmentation"].scale]
        return
   
    print(f'Path: {global_params.config.kd_seg_path}')
    if global_params.config.kd_seg_path == f'/cajal/nvmescratch/projects/songbird/j0126/areaxfs_v5/knossosdatasets/':
        path = f'/new_mounts/wholebrain/songbird/j0126/areaxfs_v5/knossosdatasets'
        params["segmentation"] = KnossosDataset(path)
    elif params.version == 'assembled_core_relabeled':
        path = f'/new_mounts/wholebrain/songbird/j0126/areaxfs_v5/knossosdatasets'
        params["segmentation"] = KnossosDataset(path)
    else:
        params["segmentation"] = KnossosDataset('/new_mounts/ssdscratch/songbird/j0251/segmentation/j0251_72_seg_20210127_agglo2')
    params["boundary"] = params["segmentation"].boundary
    params["ssvs"] = ssd.ssv_ids
    if params.version == '72_seg_20210127_agglo2_syn_20220811_celltypes_20230822':
        params["celltypes"] = ssd.load_numpy_data("celltype_pts_e3")
    else:
        params["celltypes"] = ssd.load_numpy_data("celltype_cnn_e3")
    params["mis"] = ssd.load_numpy_data("mi")
    params["sizes"] = ssd.load_numpy_data("size")
    params["neuron_partners"] = sd.load_numpy_data("neuron_partners")
    params["partner_axoness"] = sd.load_numpy_data("partner_axoness")
    params["partner_celltypes"] = sd.load_numpy_data("partner_celltypes")
    params["syn_probs"] = sd.load_numpy_data("syn_prob")
    params["mesh_areas"] = sd.load_numpy_data("mesh_area")
    params["rep_coords"] = sd.load_numpy_data("rep_coord")
    if params.acquisition != 'zf':
        params["info"] = generate_info(params["segmentation"])
        
    if 'j0251' in wd:
        name = wd.split('/')[-1]
        if name == "rag_flat_Jan2019_v3":
            params['tpl_mask'] = np.load(f"/home/shared/j0251/j0251_{name}/tpl_mask.npy")
        elif "_celltypes_20230822" in name:
            params['tpl_mask'] = np.load(f"/home/shared/j0251/j0251_72_seg_20210127_agglo2_syn_20220811_celltypes_20230822/tpl_mask.npy")
        else:
            params['tpl_mask'] = ssd.load_numpy_data('total_edge_length_mask')
        

def initialize_server(dev: bool = False, dataset: str = None):
    # server variables
    global global_server
    global_server = None

    global params, zf_params
    
    params = NeuroConfig()

    root = "/new_mounts/wholebrain/songbird"
    # logger.info("RUNNING THIS SCRIPT")
    logger.info(
         "Initializing segmentation datasets and property arrays for fw363-2021-11-02-full-nokd-nossv")
    global_params.wd = os.path.join(root, "fw363-2021-11-02-full-nokd-nossv")
    zf_params = {}
    zf_params["working_dir"] = global_params.config.working_dir
    sd_syn_ssv = SegmentationDataset("syn_ssv", working_dir=global_params.config.working_dir)

    with open(os.path.join(root, 'cs_lookup2.pickle'), 'rb') as handle:
        cs_lookup = pickle.load(handle)

    zf_params["cs_ids"] = sd_syn_ssv.load_numpy_data("cs_ids")
    zf_params["rep_coord"] = sd_syn_ssv.load_numpy_data("rep_coord")
    zf_params["cs_lookup"] = cs_lookup

    # map command line arguments to dataset names
    ds_key = {
        'v3': {
            'acq': 'j0251',
            'ver': 'rag_flat_Jan2019_v3',
            'wd': '/new_mounts/ssdscratch/songbird/j0251/rag_flat_Jan2019_v3'
        },
        'agglo2': {
            'acq': 'j0251',
            'ver': '72_seg_20210127_agglo2',
            'wd': '/new_mounts/ssdscratch/songbird/j0251/j0251_72_seg_20210127_agglo2'
        },
        'agglo2_syn': {
            'acq': 'j0251',
            'ver': '72_seg_20210127_agglo2_syn_20220811_celltypes_20230822',
            'wd': '/new_mounts/wholebrain/songbird/j0251/j0251_72_seg_20210127_agglo2_syn_20220811_celltypes_20230822'    
        },    
        'areaxfs': {
            'acq': 'j0126',
            'ver': 'areaxfs_v10',
            'wd': '/new_mounts/wholebrain/songbird/j0126/ssdscratch_wds/areaxfs_v10_v4b_base_20180214_full_agglo_cbsplit'
        },
        'assembled': {
            'acq': 'j0126',
            'ver': 'assembled_core_relabeled',
            'wd': '/new_mounts/wholebrain/songbird/j0126/ssdscratch_wds/assembled_core_relabeled_base_merges_relabeled_to_v4b_base_20180214_full_agglo_cbsplit_with_reconnects_no_soma_merger_manual_edges_removed'
        },
        'zf': {
            'acq': 'zf',
            'ver': 'fw363',
            'wd': '/new_mounts/wholebrain/songbird/fw363-2021-11-02-full-nokd-nossv'
        }
    }
    
    if dev:
        # development mode, load user-specified dataset
        params.acquisition = ds_key[dataset]['acq']
        params.version = ds_key[dataset]['ver']
        # if params.acquisition != 'zf':
        load_dataset(ds_key[dataset]['wd'], global_params, logger)
    else:
        # production mode, load all datasets
        for _, v in ds_key.items():
            acq, ver, wd = v.values()
            params.acquisition = acq
            params.version = ver
            load_dataset(wd, global_params, logger)

    global segment_properties_info

    segment_properties_info = {
        "@type": "neuroglancer_segment_properties",
        "inline": {
            "ids": None,
            "properties": [
                {
                    "id": "cell types",
                    "type": "tags",
                    "tags": None,
                    "values": None
                },
            ]
        }
    }
    
    """
    logger.info("Initializing segmentation datasets for j0126_areaxfs_v10")
    params.acquisition = "j0126"
    params.version = "areaxfs_v10"
    global_params.wd = os.path.join(root, "j0126/ssdscratch_wds", "areaxfs_v10_v4b_base_20180214_full_agglo_cbsplit")
    params["working_dir"] = global_params.config.working_dir
    ssd = SuperSegmentationDataset(global_params.config.working_dir)
    sd = SegmentationDataset(obj_type='syn_ssv', working_dir=global_params.config.working_dir)
    params["ssd"] = ssd
    params["segmentation"] = KnossosDataset(global_params.config.kd_seg_path)
    params["segmentation_path"] = global_params.config.kd_seg_path
    params["image"] = KnossosDataset(os.path.join(global_params.config.kd_seg_path))
    params["boundary"] = [int(b) for b in params["segmentation"].boundary]
    params["scale"] = [int(s) for s in params["segmentation"].scale]

    logger.info("Initializing property arrays for j0126_areaxfs_v10")
    params["ssvs"] = ssd.ssv_ids
    params["celltypes"] = ssd.load_numpy_data("celltype_cnn_e3")
    params["mis"] = ssd.load_numpy_data("mi")
    params["sizes"] = ssd.load_numpy_data("size")
    params["neuron_partners"] = sd.load_numpy_data("neuron_partners")
    params["partner_axoness"] = sd.load_numpy_data("partner_axoness")
    params["partner_celltypes"] = sd.load_numpy_data("partner_celltypes")
    params["syn_probs"] = sd.load_numpy_data("syn_prob")
    params["mesh_areas"] = sd.load_numpy_data("mesh_area")
    params["rep_coords"] = sd.load_numpy_data("rep_coord")
    params["info"] = generate_info(params["segmentation"])


    logger.info("Initializing segmentation datasets for j0126_assembled_core_relabeled")
    params.version = "assembled_core_relabeled"
    global_params.wd = os.path.join(root, "j0126/ssdscratch_wds", "assembled_core_relabeled_base_merges_relabeled_to_v4b_base_20180214_full_agglo_cbsplit_with_reconnects_no_soma_merger_manual_edges_removed")
    params["working_dir"] = global_params.config.working_dir
    ssd = SuperSegmentationDataset(global_params.config.working_dir)
    sd = SegmentationDataset(obj_type='syn_ssv', working_dir=global_params.config.working_dir)
    params["ssd"] = ssd
    params["segmentation"] = KnossosDataset(global_params.config.kd_seg_path)
    params["segmentation_path"] = global_params.config.kd_seg_path
    params["image"] = KnossosDataset(os.path.join(global_params.config.kd_seg_path))
    params["boundary"] = [int(b) for b in params["segmentation"].boundary]
    params["scale"] = [int(s) for s in params["segmentation"].scale]

    logger.info("Initializing property arrays for j0126_assembled_core_relabeled")
    params["ssvs"] = ssd.ssv_ids
    params["celltypes"] = ssd.load_numpy_data("celltype_cnn_e3")
    params["mis"] = ssd.load_numpy_data("mi")
    params["sizes"] = ssd.load_numpy_data("size")
    params["neuron_partners"] = sd.load_numpy_data("neuron_partners")
    params["partner_axoness"] = sd.load_numpy_data("partner_axoness")
    params["partner_celltypes"] = sd.load_numpy_data("partner_celltypes")
    params["syn_probs"] = sd.load_numpy_data("syn_prob")
    params["mesh_areas"] = sd.load_numpy_data("mesh_area")
    params["rep_coords"] = sd.load_numpy_data("rep_coord")
    params["info"] = generate_info(params["segmentation"])


    root = "/ssdscratch/songbird"
    logger.info("Initializing segmentation datasets for j0251_rag_flat_Jan2019_v3")
    params.acquisition = "j0251"
    params.version = "rag_flat_Jan2019_v3"
    global_params.wd = os.path.join(root, "j0251", "rag_flat_Jan2019_v3")
    params["working_dir"] = global_params.config.working_dir
    ssd = SuperSegmentationDataset(global_params.config.working_dir, sso_locking=False, sso_caching=True)
    sd = SegmentationDataset(obj_type='syn_ssv', working_dir=global_params.config.working_dir)
    params["ssd"] = ssd
    params["segmentation"] = KnossosDataset(global_params.config.kd_seg_path)
    params["segmentation_path"] = global_params.config.kd_seg_path
    params["image"] = KnossosDataset("/wholebrain/songbird/j0251/j0251_72_clahe2")
    params["boundary"] = [int(b) for b in params["segmentation"].boundary]
    params["scale"] = [int(s) for s in params["segmentation"].scale]

    logger.info("Initializing property arrays for j0251_rag_flat_Jan2019_v3")
    params["ssvs"] = ssd.ssv_ids
    params["celltypes"] = ssd.load_numpy_data("celltype_cnn_e3")
    params["mis"] = ssd.load_numpy_data("mi")
    params["sizes"] = ssd.load_numpy_data("size")
    params["neuron_partners"] = sd.load_numpy_data("neuron_partners")
    params["partner_axoness"] = sd.load_numpy_data("partner_axoness")
    params["partner_celltypes"] = sd.load_numpy_data("partner_celltypes")
    params["syn_probs"] = sd.load_numpy_data("syn_prob")
    params["mesh_areas"] = sd.load_numpy_data("mesh_area")
    params["rep_coords"] = sd.load_numpy_data("rep_coord")
    params["tpl_mask"] = np.load(f"/home/shared/j0251/j0251_rag_flat_Jan2019_v3/tpl_mask.npy")
    params["info"] = generate_info(params["segmentation"])
    

    logger.info("Initializing segmentation datasets for j0251_72_seg_20210127_agglo2")
    params.version = "72_seg_20210127_agglo2"
    global_params.wd = os.path.join(root, "j0251", "j0251_72_seg_20210127_agglo2")
    params["working_dir"] = global_params.config.working_dir
    ssd = SuperSegmentationDataset(global_params.config.working_dir, sso_locking=False, sso_caching=True)
    sd = SegmentationDataset(obj_type='syn_ssv', working_dir=global_params.config.working_dir)
    params["ssd"] = ssd
    # params["segmentation"] = KnossosDataset(global_params.config.kd_seg_path)
    params["segmentation"] = KnossosDataset("/ssdscratch/songbird/j0251/segmentation/j0251_72_seg_20210127_agglo2/knossos.pyk.conf")
    params["segmentation_path"] = global_params.config.kd_seg_path
    params["image"] = KnossosDataset("/wholebrain/songbird/j0251/j0251_72_clahe2")
    params["boundary"] = [int(b) for b in params["segmentation"].boundary]
    params["scale"] = [int(s) for s in params["segmentation"].scale]

    logger.info("Initializing property arrays for j0251_72_seg_20210127_agglo2")
    params["ssvs"] = ssd.ssv_ids
    params["celltypes"] = ssd.load_numpy_data("celltype_cnn_e3")
    params["mis"] = ssd.load_numpy_data("mi")
    params["sizes"] = ssd.load_numpy_data("size")
    params["neuron_partners"] = sd.load_numpy_data("neuron_partners")
    params["partner_axoness"] = sd.load_numpy_data("partner_axoness")
    params["partner_celltypes"] = sd.load_numpy_data("partner_celltypes")
    params["syn_probs"] = sd.load_numpy_data("syn_prob")
    params["mesh_areas"] = sd.load_numpy_data("mesh_area")
    params["rep_coords"] = sd.load_numpy_data("rep_coord")
    params["tpl_mask"] = np.load(f"/home/shared/j0251/j0251_72_seg_20210127_agglo2/tpl_mask.npy")
    params["info"] = generate_info(params["segmentation"])
    """
    
    
