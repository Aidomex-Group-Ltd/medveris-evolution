/**
 * Workers VPC binding shape. In the Workers runtime a `vpc_services` binding is an object with a
 * `fetch` method that routes the request onto the private network through the tunnel — the URL host
 * is a routing label, not a resolved address. The path and query string are forwarded unchanged.
 */
export interface VpcServiceBinding {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
}

/** Fetch-like that routes every call through the VPC service binding. */
export function vpcServiceFetch(binding: VpcServiceBinding): (input: string, init?: RequestInit) => Promise<Response> {
  return (input, init) => binding.fetch(input, init);
}
