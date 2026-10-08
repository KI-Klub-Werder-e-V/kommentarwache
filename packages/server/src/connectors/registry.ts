/**
 * The connector kinds this build knows. `fake` is an in-memory platform for demos and
 * tests; `api` is the generic REST source acting through signed callbacks; the rest are
 * platform connectors. A kind whose credentials are missing fails to build and the
 * engine queues the comment for a human instead.
 */

import { ApiCallbackConnector } from './api.js';
import { ConnectorRegistry, FakeConnector } from './connector.js';
import { FacebookPageConnector, InstagramConnector } from './meta.js';
import { YouTubeConnector } from './youtube.js';

export const CONNECTOR_KINDS = ['api', 'fake', 'youtube', 'facebook', 'instagram'] as const;
export const POLLING_KINDS = ['youtube', 'facebook', 'instagram'] as const;

export function defaultConnectorRegistry(): ConnectorRegistry {
  return new ConnectorRegistry()
    .register('fake', () => new FakeConnector())
    .register('api', (row) => new ApiCallbackConnector(row))
    .register('youtube', (row) => new YouTubeConnector(row))
    .register('facebook', (row) => new FacebookPageConnector(row))
    .register('instagram', (row) => new InstagramConnector(row));
}
