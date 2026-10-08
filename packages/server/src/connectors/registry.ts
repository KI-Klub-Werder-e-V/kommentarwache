/**
 * The connector kinds this build knows. Platform connectors (YouTube, Meta, ...) register
 * here as they land; `fake` is an in-memory platform for demos and tests, and `api` is
 * the generic REST source, which acts through callbacks once milestone 5 adds them.
 */

import { ConnectorRegistry, FakeConnector } from './connector.js';

export function defaultConnectorRegistry(): ConnectorRegistry {
  return new ConnectorRegistry().register('fake', () => new FakeConnector());
}
