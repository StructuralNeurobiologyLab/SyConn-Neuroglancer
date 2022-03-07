from knossos_utils import KnossosDataset


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
        } for i in sorted(kd.available_mags)
    ]

    return info
        

def initialize_server():
    # server variables
    global global_server
    global_server = None

    # development mode
    global dev_environ
    dev_environ = None

    from syconn.reps import super_segmentation_dataset as ss
    from syconn.reps import segmentation as seg
    from syconn import global_params
    from syconn.analysis.backend import SyConnBackend
    from syconn.handler.logger import log_main as logger
    from knossos_utils import KnossosDataset
    import os
    import numpy as np

    global params
    
    params = NeuroConfig()

    root = "/wholebrain/songbird"
    logger.info("Initializing SyConn backend and Knossos datasets for j0126_areaxfs_v10")

    params.acquisition = "j0126"
    params.version = "areaxfs_v10"
    
    global_params.wd = os.path.join(root, "j0126/ssdscratch_wds", "areaxfs_v10_v4b_base_20180214_full_agglo_cbsplit")
    params["working_dir"] = global_params.config.working_dir
    ssd = ss.SuperSegmentationDataset(global_params.config.working_dir)
    sd = seg.SegmentationDataset(obj_type='syn_ssv', working_dir=global_params.config.working_dir)
    params["ssd"] = ssd
    params["segmentation"] = KnossosDataset(global_params.config.kd_seg_path)
    params["segmentation_path"] = global_params.config.kd_seg_path
    params["image"] = KnossosDataset(os.path.join(global_params.config.kd_seg_path))
    params["boundary"] = [int(b) for b in params["segmentation"].boundary]
    params["scale"] = [int(s) for s in params["segmentation"].scale]

    logger.info("Initializing npy arrays for j0126_areaxfs_v10")
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


    logger.info("Initializing SyConn backend and Knossos datasets for j0126_assembled_core_relabeled")
    params.version = "assembled_core_relabeled"
    global_params.wd = os.path.join(root, "j0126/ssdscratch_wds", "assembled_core_relabeled_base_merges_relabeled_to_v4b_base_20180214_full_agglo_cbsplit_with_reconnects_no_soma_merger_manual_edges_removed")
    params["working_dir"] = global_params.config.working_dir
    ssd = ss.SuperSegmentationDataset(global_params.config.working_dir)
    sd = seg.SegmentationDataset(obj_type='syn_ssv', working_dir=global_params.config.working_dir)
    params["ssd"] = ssd
    params["segmentation"] = KnossosDataset(global_params.config.kd_seg_path)
    params["segmentation_path"] = global_params.config.kd_seg_path
    params["image"] = KnossosDataset(os.path.join(global_params.config.kd_seg_path))
    params["boundary"] = [int(b) for b in params["segmentation"].boundary]
    params["scale"] = [int(s) for s in params["segmentation"].scale]

    logger.info("Initializing npy arrays for j0126_assembled_core_relabeled")
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
    logger.info("Initializing SyConn backend and Knossos datasets for j0251_rag_flat_Jan2019_v3")

    params.acquisition = "j0251"
    params.version = "rag_flat_Jan2019_v3"

    global_params.wd = os.path.join(root, "j0251", "rag_flat_Jan2019_v3")
    params["working_dir"] = global_params.config.working_dir
    ssd = ss.SuperSegmentationDataset(global_params.config.working_dir, sso_locking=False, sso_caching=True)
    sd = seg.SegmentationDataset(obj_type='syn_ssv', working_dir=global_params.config.working_dir)
    params["ssd"] = ssd
    params["segmentation"] = KnossosDataset(global_params.config.kd_seg_path)
    params["segmentation_path"] = global_params.config.kd_seg_path
    params["image"] = KnossosDataset("/wholebrain/songbird/j0251/j0251_72_clahe2")
    params["boundary"] = [int(b) for b in params["segmentation"].boundary]
    params["scale"] = [int(s) for s in params["segmentation"].scale]

    logger.info("Initializing npy arrays for j0251_rag_flat_Jan2019_v3")
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
    params["tpl_mask"] = np.load(f"/home/shared/{params.acquisition}/{params.acquisition}_{params.version}/tpl_mask.npy")
    params["info"] = generate_info(params["segmentation"])
    

    logger.info("Initializing SuperSegmentationDataset and KnossosDataset for j0251_72_seg_20210127_agglo2")

    params.version = "72_seg_20210127_agglo2"

    global_params.wd = os.path.join(root, "j0251", "j0251_72_seg_20210127_agglo2")
    params["working_dir"] = global_params.config.working_dir
    ssd = ss.SuperSegmentationDataset(global_params.config.working_dir, sso_locking=False, sso_caching=True)
    sd = seg.SegmentationDataset(obj_type='syn_ssv', working_dir=global_params.config.working_dir)
    params["ssd"] = ssd
    # params["segmentation"] = KnossosDataset(global_params.config.kd_seg_path)
    params["segmentation"] = KnossosDataset("/ssdscratch/songbird/j0251/segmentation/j0251_72_seg_20210127_agglo2/knossos.pyk.conf")
    params["segmentation_path"] = global_params.config.kd_seg_path
    params["image"] = KnossosDataset("/wholebrain/songbird/j0251/j0251_72_clahe2")
    params["boundary"] = [int(b) for b in params["segmentation"].boundary]
    params["scale"] = [int(s) for s in params["segmentation"].scale]

    logger.info("Initializing npy arrays for j0251_72_seg_20210127_agglo2")

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
    params["tpl_mask"] = np.load(f"/home/shared/{params.acquisition}/{params.acquisition}_{params.version}/tpl_mask.npy")
    params["info"] = generate_info(params["segmentation"])
   
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