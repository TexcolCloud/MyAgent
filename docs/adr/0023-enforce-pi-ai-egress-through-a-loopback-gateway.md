# Enforce pi-ai egress through a loopback gateway

Model invocation uses pi-ai for provider semantics, but every outbound request first reaches a short-lived loopback Provider Egress Gateway owned by the service. The gateway resolves the exact Connection Revision and Secret, then applies the existing authentication, SSRF, redirect, timeout, and response-size policy; direct SDK networking, global interception, and a maintained pi-ai fork were rejected because they either bypass the trust boundary or create an unsustainable upstream dependency.
