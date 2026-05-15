const si = require("systeminformation");
const HID = require("node-hid");
const { SerialPort } = require("serialport");
const usb = require("usb");

(async () => {
  console.log("\n== serial ports ==");
  console.log(await SerialPort.list()); // look for: path, serialNumber

  console.log("\n== hid devices ==");
  console.log(HID.devices()); // look for: path, vendorId, productId, serialNumber

  console.log("\n== usb devices (low-level) ==");
  console.log(usb.getDeviceList().map(d => ({
    busNumber: d.busNumber,
    deviceAddress: d.deviceAddress,
    vid: d.deviceDescriptor.idVendor,
    pid: d.deviceDescriptor.idProduct
  })));

  console.log("\n== systeminformation usb() ==");
  console.log(await si.usb()); // higher-level USB list :contentReference[oaicite:4]{index=4}

  console.log("\n== systeminformation bluetoothDevices() ==");
  console.log(await si.bluetoothDevices()); // bluetooth list :contentReference[oaicite:5]{index=5}

  console.log("\n== systeminformation networkInterfaces() ==");
  console.log(await si.networkInterfaces());

  console.log("\n== systeminformation blockDevices() ==");
  console.log(await si.blockDevices());
})();
