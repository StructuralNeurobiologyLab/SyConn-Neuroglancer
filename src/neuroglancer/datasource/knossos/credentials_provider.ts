/**
*  Source code created by Max Planck Institute of Neuobiology
*
* Authors: Andrei Mancu, Hashir Ahmad, Philipp Schubert, Joergen Kornfeld
* */

import {CredentialsProvider, makeCredentialsGetter} from 'neuroglancer/credentials_provider';
import {StatusMessage} from 'neuroglancer/status';
import {CANCELED, CancellationTokenSource, uncancelableToken} from 'neuroglancer/util/cancellation';
import {verifyObject, verifyString} from 'neuroglancer/util/json';
import {getRandomHexString} from 'neuroglancer/util/random';
import {Signal} from 'neuroglancer/util/signal';


export type KnossosToken = string;

class PendingRequest {
  finished = new Signal<(token?: KnossosToken, error?: any) => void>();
}

class AuthHandler {
  oidcCallbackService = `knossosAuthCallback`;             //TODO do we need this?
  relayReadyPromise: Promise<void>;
  pendingRequests = new Map<string, PendingRequest>();

  constructor() {
    this.registerListener();
  }

  registerListener() {
    addEventListener('message', (event: MessageEvent) => {
      if (event.origin !== location.origin) {
        // Ignore messages from different origins.
        return;
      }
      try {
        let data = verifyObject(JSON.parse(event.data));
        let service = verifyString(data['service']);
        if (service === this.oidcCallbackService) {
          let accessToken = verifyString(data['access_token']);
          let state = verifyString(data['state']);
          let request = this.pendingRequests.get(state);
          if (request === undefined) {
            // Request may have been cancelled.
            return;
          }
          request.finished.dispatch(accessToken);
        }
      } catch (parseError) {
        // Ignore invalid message.
      }
    });
  }

  addPendingRequest(state: string) {
    let request = new PendingRequest();
    this.pendingRequests.set(state, request);
    request.finished.add(() => {
      this.pendingRequests.delete(state);
    });
    return request;
  }

  makeAuthRequestUrl(options: {
    authServer: string,
    clientId: string,
    redirect_uri: string,
    state?: string,
    nonce?: string
  }) {
    let url = `${options.authServer}/realms/KNOSSOS/protocol/openid-connect/auth?`;         //TODO do we need this?
    url += `client_id=${encodeURIComponent(options.clientId)}`;
    url += `&redirect_uri=${encodeURIComponent(options.redirect_uri)}`;
    url += `&response_mode=fragment`;
    url += `&response_type=code%20id_token%20token`;
    if (options.state) {
      url += `&state=${options.state}`;
    }
    if (options.nonce) {
      url += `&nonce=${options.nonce}`;
    }
    return url;
  }
}

let authHandlerInstance: AuthHandler;

function authHandler() {
  if (authHandlerInstance === undefined) {
    authHandlerInstance = new AuthHandler();
  }
  return authHandlerInstance;
}


/**
 * Obtain a Keycloak OIDC authentication token.
 * @return A Promise that resolves to an authentication token.
 */
export function authenticateKeycloakOIDC(
    options: {realm: string, clientId: string, authServer: string},
    cancellationToken = uncancelableToken) {
  const state = getRandomHexString();
  const nonce = getRandomHexString();
  const handler = authHandler();
  const url = handler.makeAuthRequestUrl({
    state: state,
    clientId: options.clientId,
    redirect_uri: new URL('knossosauth.html', window.location.href).href,
    authServer: options.authServer,
    nonce: nonce
  });
  const request = handler.addPendingRequest(state);
  const promise = new Promise<KnossosToken>((resolve, reject) => {
    request.finished.add((token: string, error: string) => {
      if (token !== undefined) {
        resolve(token);
      } else {
        reject(error);
      }
    });
  });
  request.finished.add(cancellationToken.add(() => {
    request.finished.dispatch(undefined, CANCELED);
  }));
  if (!cancellationToken.isCanceled) {
    const newWindow = open(url);
    if (newWindow !== null) {
      request.finished.add(() => {
        newWindow.close();
      });
    }
  }
  return promise;
}



export class KnossosCredentialsProvider extends CredentialsProvider<KnossosToken> {
  constructor(public authServer: string) {
    super();
  }

  get = makeCredentialsGetter(cancellationToken => {
    const status = new StatusMessage(/*delay=*/true);
    let cancellationSource: CancellationTokenSource|undefined;
    return new Promise<KnossosToken>((resolve, reject) => {
      const dispose = () => {
        cancellationSource = undefined;
        status.dispose();
      };
      cancellationToken.add(() => {
        if (cancellationSource !== undefined) {
          cancellationSource.cancel();
          cancellationSource = undefined;
          status.dispose();
          reject(CANCELED);
        }
      });
      function writeLoginStatus(
          msg = 'Knossos authorization required.', linkMessage = 'Request authorization.') {
        status.setText(msg + ' ');
        let button = document.createElement('button');
        button.textContent = linkMessage;
        status.element.appendChild(button);
        button.addEventListener('click', () => {
          login();
        });
        status.setVisible(true);
      }
      let authServer = this.authServer;
      function login() {
        if (cancellationSource !== undefined) {
          cancellationSource.cancel();
        }
        cancellationSource = new CancellationTokenSource();
        writeLoginStatus('Waiting for Knossos authorization...', 'Retry');
        authenticateKeycloakOIDC(
            {realm: 'knossos', clientId: 'endpoint', authServer: authServer}, cancellationSource)
            .then(
                token => {
                  if (cancellationSource !== undefined) {
                    dispose();
                    resolve(token);
                  }
                },
                reason => {
                  if (cancellationSource !== undefined) {
                    cancellationSource = undefined;
                    writeLoginStatus(`Knossos authorization failed: ${reason}.`, 'Retry');
                  }
                });
      }
      writeLoginStatus();
    });
  });
}
