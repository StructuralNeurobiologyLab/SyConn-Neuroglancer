/**
*  Source code created by Max Planck Institute of Neuobiology
*
* Authors: Andrei Mancu, Hashir Ahmad, Philipp Schubert, Joergen Kornfeld
* */

import {KnossosDataSource} from 'neuroglancer/datasource/knossos/frontend';
import {registerProvider} from 'neuroglancer/datasource/default_provider';

registerProvider('knossos', options => new KnossosDataSource(options.credentialsManager));
