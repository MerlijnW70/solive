import { describe, expect, it } from "vitest";
import { hostAddresses, ipFamily, loopbackAddress, privateAddress, publicAddresses, publicHost } from "../src/address-ranges.js";

describe("embedded IPv4 addresses", () => {
  it("reads the octets of a mapped address and judges the public ones public", () => {
    expect(privateAddress("::ffff:8.8.8.8")).toBe(false);
    expect(privateAddress("::ffff:8.8.8.8".toUpperCase())).toBe(false);
    expect(privateAddress("::ffff:1.2.3.4")).toBe(false);
    expect(privateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(privateAddress("::ffff:192.168.1.1")).toBe(true);
    expect(privateAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("treats a mapped form only when the first five groups are zero and the sixth is ffff", () => {
    expect(privateAddress("1::ffff:10.0.0.1")).toBe(false);
    expect(privateAddress("::5:10.0.0.1")).toBe(false);
    expect(privateAddress("0:0:0:0:1:ffff:10.0.0.1")).toBe(false);
    expect(privateAddress("::5:8.8.8.8")).toBe(false);
  });

  it("refuses the deprecated compatible form and the translated form", () => {
    expect(privateAddress("::8.8.8.8")).toBe(true);
    expect(privateAddress("::1")).toBe(true);
    expect(privateAddress("::2")).toBe(true);
    expect(privateAddress("::ffff:0:8.8.8.8")).toBe(true);
    expect(privateAddress("::5:5:8.8.8.8")).toBe(false);
    expect(privateAddress("1::8.8.8.8")).toBe(false);
    expect(privateAddress("1::1")).toBe(false);
  });

  it("looks through a 6to4 address to the address it embeds", () => {
    expect(privateAddress("2002:0808:0808::1")).toBe(false);
    expect(privateAddress("2002:0a00:0001::1")).toBe(true);
  });

  it("looks through a Teredo address at its server and at its obfuscated client", () => {
    expect(privateAddress("2001:0:808:808:0:0:f7f7:f7f7")).toBe(false);
    expect(privateAddress("2001:0:808:808:0:0:f5ff:fffe")).toBe(true);
    expect(privateAddress("2001:0:a00:1:0:0:f7f7:f7f7")).toBe(true);
    expect(privateAddress("2001:0:a00:1:0:0:f5ff:fffe")).toBe(true);
    expect(privateAddress("2001:0:808:808:0:0:0:0")).toBe(true);
    expect(privateAddress("2001:0:808:808:0:0:ffff:ffff")).toBe(true);
    expect(privateAddress("2001:0:808:808:0:0:3fff:fdfa")).toBe(true);
    expect(privateAddress("2001:0:808:808:0:0:3fff:fcfa")).toBe(false);
  });

  it("applies the Teredo rule only to the 2001:0 prefix", () => {
    expect(privateAddress("1:0:808:808::1")).toBe(false);
    expect(privateAddress("2001:1:a00:1::1")).toBe(false);
    expect(privateAddress("2001:2:808:808::1")).toBe(false);
  });
});

describe("IPv6 ranges", () => {
  it("refuses unique-local, link-local, site-local and multicast ranges at their edges", () => {
    for (const ip of ["fc00::1", "fd12:3456::1", "fdff::1", "fe80::1", "febf::1", "fec0::1", "fedf::1", "feff::1", "ff00::1", "ff02::1", "ffff::1"]) {
      expect(privateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["fbff::1", "fe00::1", "fe7f::1", "fe40::1", "f000::1", "2606:4700::1111", "ff::1", "1::1"]) {
      expect(privateAddress(ip), ip).toBe(false);
    }
  });

  it("refuses the documentation and the NAT64 prefixes only when both groups match", () => {
    expect(privateAddress("2001:db8::1")).toBe(true);
    expect(privateAddress("64:ff9b::1")).toBe(true);
    expect(privateAddress("2001:1::1")).toBe(false);
    expect(privateAddress("3:db8::1")).toBe(false);
    expect(privateAddress("64:1::1")).toBe(false);
    expect(privateAddress("1:ff9b::1")).toBe(false);
    expect(privateAddress("2001:db9::1")).toBe(false);
    expect(privateAddress("65:ff9b::1")).toBe(false);
  });
});

describe("what counts as an address", () => {
  it("answers true for text that is no address at all", () => {
    expect(privateAddress("not-an-ip")).toBe(true);
    expect(privateAddress("")).toBe(true);
    expect(privateAddress("example.com")).toBe(true);
    expect(privateAddress("1.2.3")).toBe(true);
    expect(privateAddress("256.1.1.1")).toBe(true);
  });

  it("reads the family of IPv4, IPv6 and zoned text", () => {
    expect(ipFamily("8.8.8.8")).toBe(4);
    expect(ipFamily("2606:4700::1111")).toBe(6);
    expect(ipFamily("fe80::1%eth0")).toBe(6);
    expect(ipFamily("fe80::1%")).toBe(0);
    expect(ipFamily("fe80::1%eth 0")).toBe(0);
    expect(ipFamily("%eth0")).toBe(0);
    expect(ipFamily("%::1")).toBe(0);
    expect(ipFamily("g::1")).toBe(0);
    expect(ipFamily("1:2:3:4:5:6:7:zzzz")).toBe(0);
    expect(ipFamily("12345::1")).toBe(0);
    expect(ipFamily("1:2:3:4:5:6:7:8")).toBe(6);
    expect(ipFamily("1:2:3:4:5:6:7")).toBe(0);
    expect(ipFamily("1::2::3")).toBe(0);
    expect(ipFamily("example.com")).toBe(0);
  });

  it("returns 0 for text with too many groups around a gap", () => {
    expect(ipFamily("1:2:3:4:5:6:7:8::9")).toBe(0);
    expect(ipFamily("1:2:3:4:5:6:7:8:9::")).toBe(0);
    expect(privateAddress("1:2:3:4:5:6:7:8::9")).toBe(true);
  });

  it("reads loopback in IPv4, IPv6 and mapped forms only", () => {
    expect(loopbackAddress("127.0.0.1")).toBe(true);
    expect(loopbackAddress("127.255.255.255")).toBe(true);
    expect(loopbackAddress("128.0.0.1")).toBe(false);
    expect(loopbackAddress("::1")).toBe(true);
    expect(loopbackAddress("::2")).toBe(false);
    expect(loopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(loopbackAddress("::ffff:8.8.8.8")).toBe(false);
    expect(loopbackAddress("1::1")).toBe(false);
    expect(loopbackAddress("example.com")).toBe(false);
  });
});

describe("resolving a host", () => {
  const lookup = (answers: string[]) => async () => answers;

  it("keeps an empty answer from passing as a public host", async () => {
    expect(await publicAddresses("example.com", lookup([]))).toBeNull();
    expect(await publicAddresses("example.com", lookup(["8.8.8.8"]))).toEqual(["8.8.8.8"]);
    expect(await publicAddresses("example.com", lookup(["8.8.8.8", "10.0.0.1"]))).toBeNull();
    expect(await publicAddresses("example.com", lookup(["127.0.0.1"]), true)).toEqual(["127.0.0.1"]);
    expect(await publicAddresses("example.com", lookup(["10.0.0.1"]), true)).toBeNull();
  });

  it("answers whether a host is public", async () => {
    expect(await publicHost("example.com", lookup(["8.8.8.8"]))).toBe(true);
    expect(await publicHost("example.com", lookup(["10.0.0.1"]))).toBe(false);
    expect(await publicHost("example.com", lookup([]))).toBe(false);
    expect(await publicHost("8.8.8.8", lookup([]))).toBe(true);
    expect(await publicHost("[::1]", lookup([]))).toBe(false);
  });

  it("keeps a local name out unless loopback is allowed, and leaves other names to the caller", async () => {
    expect(await hostAddresses("localhost", null)).toBeNull();
    expect(await hostAddresses("app.localhost.", null)).toBeNull();
    expect(await hostAddresses("localhost", null, true)).toBeUndefined();
    expect(await hostAddresses("example.com", null)).toBeUndefined();
    expect(await hostAddresses("example.com", lookup(["8.8.8.8"]))).toEqual(["8.8.8.8"]);
    expect(await hostAddresses("[::ffff:8.8.8.8]", null)).toEqual(["::ffff:8.8.8.8"]);
    expect(await hostAddresses("10.0.0.1", null)).toBeNull();
  });
});
