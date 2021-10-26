/**
*  Source code created by Max Planck Institute of Neuobiology
*
* Authors: Andrei Mancu, Hashir Ahmad, Philipp Schubert, Joergen Kornfeld
* */

import {CredentialsProvider} from 'neuroglancer/credentials_provider';
import {fetchWithCredentials} from 'neuroglancer/credentials_provider/http_request';
import {CancellationToken, uncancelableToken} from 'neuroglancer/util/cancellation';
import {ResponseTransform} from 'neuroglancer/util/http_request';

export type KnossosToken = string;

/**
 * Key used for retrieving the CredentialsProvider from a CredentialsManager.
 */
export const credentialsKey = 'knossos';

export function fetchWithKnossosCredentials<T>(
    credentialsProvider: CredentialsProvider<KnossosToken>, input: RequestInfo, init: RequestInit,
    transformResponse: ResponseTransform<T>,
    cancellationToken: CancellationToken = uncancelableToken): Promise<T> {
  return fetchWithCredentials(
      credentialsProvider, input, init, transformResponse,
      credentials => {
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${credentials}`);
        return {...init, headers};
      },
      error => {
        const {status} = error;
        if (status === 403 || status === 401) {
          // Authorization needed.  Retry with refreshed token.
          return 'refresh';
        }
        if (status === 504) {
          // Gateway timeout can occur if the server takes too long to reply.  Retry.
          return 'retry';
        }
        throw error;
      },
      cancellationToken);
}
