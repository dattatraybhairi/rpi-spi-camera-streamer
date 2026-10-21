import React from 'react';
import { StreamConfig } from '../data/rpiTemplates';

interface GpioPinoutTableProps {
  config: StreamConfig;
}

interface PinRow {
  signal: string;
  physicalPin: string;
  bcmGpio: string;
  direction: string;
  description: string;
}

export const GpioPinoutTable: React.FC<GpioPinoutTableProps> = ({ config }) => {
  const rows: PinRow[] = [
    {
      signal: '5V Power',
      physicalPin: 'Pin 2, Pin 4',
      bcmGpio: '5V Rail',
      direction: 'Power',
      description: '5V main supply for 3.5" LCD backlight and regulator',
    },
    {
      signal: '3.3V Logic',
      physicalPin: 'Pin 1, Pin 17',
      bcmGpio: '3V3 Rail',
      direction: 'Power',
      description: '3.3V IO logic reference for ILI9486 & XPT2046',
    },
    {
      signal: 'SPI0 MOSI',
      physicalPin: 'Pin 19',
      bcmGpio: 'GPIO 10',
      direction: 'RPi → LCD',
      description: 'Master Out Slave In high-speed RGB565 pixel data line',
    },
    {
      signal: 'SPI0 MISO',
      physicalPin: 'Pin 21',
      bcmGpio: 'GPIO 9',
      direction: 'LCD → RPi',
      description: 'Master In Slave Out for XPT2046 resistive touch controller',
    },
    {
      signal: 'SPI0 SCLK',
      physicalPin: 'Pin 23',
      bcmGpio: 'GPIO 11',
      direction: 'RPi → LCD',
      description: `SPI serial clock (${(config.spiSpeedHz / 1_000_000).toFixed(0)} MHz configured)`,
    },
    {
      signal: 'LCD CS',
      physicalPin: config.spiCs === 0 ? 'Pin 24' : 'Pin 26',
      bcmGpio: config.spiCs === 0 ? 'GPIO 8 (CE0)' : 'GPIO 7 (CE1)',
      direction: 'RPi → LCD',
      description: 'Display Chip Select active-low signal',
    },
    {
      signal: 'Touch CS',
      physicalPin: config.spiCs === 0 ? 'Pin 26' : 'Pin 24',
      bcmGpio: config.spiCs === 0 ? 'GPIO 7 (CE1)' : 'GPIO 8 (CE0)',
      direction: 'RPi → Touch',
      description: 'XPT2046 Touch Chip Select',
    },
    {
      signal: 'LCD DC (RS)',
      physicalPin: `Pin 18 (Default)`,
      bcmGpio: `GPIO ${config.dcPin}`,
      direction: 'RPi → LCD',
      description: 'Register Select: LOW = Command byte, HIGH = RGB565 pixel data',
    },
    {
      signal: 'LCD RST',
      physicalPin: `Pin 22 (Default)`,
      bcmGpio: `GPIO ${config.rstPin}`,
      direction: 'RPi → LCD',
      description: 'Hardware Reset pulse during ILI9486 initialization',
    },
    {
      signal: 'Ground',
      physicalPin: 'Pin 6, 9, 14, 20, 25',
      bcmGpio: 'GND',
      direction: 'Common',
      description: 'Common signal and power return ground',
    },
  ];

  return (
    <div className="border border-slate-800 bg-slate-900/70 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">
            3.5&quot; SPI Display 40-Pin GPIO Wiring Map
          </h3>
          <p className="text-xs text-slate-400 mt-0.5">
            Direct 26-pin header pass-through or jumper wire pinout for Waveshare 3.5&quot; / MHS35 / ILI9486 SPI displays
          </p>
        </div>
        <span className="text-xs font-mono text-slate-400 tabular-nums">
          SPI{config.spiBus}.{config.spiCs} · {(config.spiSpeedHz / 1_000_000).toFixed(0)} MHz
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-slate-400 bg-slate-950/50">
              <th className="py-2.5 px-4 font-medium">Signal</th>
              <th className="py-2.5 px-4 font-medium">RPi Physical Pin</th>
              <th className="py-2.5 px-4 font-medium">BCM GPIO</th>
              <th className="py-2.5 px-4 font-medium">Direction</th>
              <th className="py-2.5 px-4 font-medium">Hardware Role</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70">
            {rows.map((row) => (
              <tr key={row.signal} className="hover:bg-slate-800/40 transition-colors">
                <td className="py-2.5 px-4 font-mono font-medium text-slate-100 whitespace-nowrap">
                  {row.signal}
                </td>
                <td className="py-2.5 px-4 font-mono text-sky-400 whitespace-nowrap tabular-nums">
                  {row.physicalPin}
                </td>
                <td className="py-2.5 px-4 font-mono text-emerald-400 whitespace-nowrap tabular-nums">
                  {row.bcmGpio}
                </td>
                <td className="py-2.5 px-4 text-slate-300 whitespace-nowrap">{row.direction}</td>
                <td className="py-2.5 px-4 text-slate-400">{row.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
