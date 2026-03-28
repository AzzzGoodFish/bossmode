import type { Room } from "../api/client";

interface RoomListProps {
  rooms: Room[];
  selectedRoomId: string | null;
  onSelectRoom: (roomId: string) => void;
  onCreateRoom: () => void;
}

export function RoomList({
  rooms,
  selectedRoomId,
  onSelectRoom,
  onCreateRoom,
}: RoomListProps) {
  return (
    <div className="flex flex-col h-full">
      <div className="p-3 flex items-center justify-between border-b border-zinc-800">
        <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
          Rooms
        </span>
        <button
          onClick={onCreateRoom}
          className="text-zinc-500 hover:text-white text-lg leading-none transition-colors cursor-pointer"
          title="Create room"
        >
          +
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {rooms.length === 0 && (
          <div className="px-3 py-6 text-center text-zinc-600 text-xs">
            No rooms yet
          </div>
        )}
        {rooms.map((room) => (
          <button
            key={room.id}
            onClick={() => onSelectRoom(room.id)}
            className={`w-full text-left px-3 py-2 text-sm transition-colors cursor-pointer ${
              selectedRoomId === room.id
                ? "bg-zinc-800 text-white"
                : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-300"
            }`}
          >
            <div className="font-medium truncate"># {room.name}</div>
            <div className="text-xs text-zinc-600 truncate">{room.cwd}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
